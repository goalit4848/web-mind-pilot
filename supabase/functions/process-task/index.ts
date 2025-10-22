import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.75.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const BROWSERLESS_API_KEY = Deno.env.get('BROWSERLESS_API_KEY');
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');

    if (!BROWSERLESS_API_KEY || !LOVABLE_API_KEY) {
      throw new Error('Required API keys not configured');
    }

    // Initialize Supabase client with service role key
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Find one pending task
    const { data: tasks, error: fetchError } = await supabase
      .from('tasks')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (fetchError) throw fetchError;
    if (!tasks || tasks.length === 0) {
      return new Response(JSON.stringify({ message: 'No pending tasks' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const task = tasks[0];
    console.log('Processing task:', task.id, task.prompt);

    // Update status to running
    const { error: updateError1 } = await supabase
      .from('tasks')
      .update({ status: 'running' })
      .eq('id', task.id);

    if (updateError1) throw updateError1;

    try {
      // Execute agent logic with stateful loop
      const result = await executeAgentLoop(
        task.id,
        task.prompt, 
        BROWSERLESS_API_KEY, 
        LOVABLE_API_KEY,
        supabase
      );

      // Update status to completed
      const { error: updateError2 } = await supabase
        .from('tasks')
        .update({ 
          status: 'completed', 
          result: result.summary,
          agent_thought: 'Task completed successfully!'
        })
        .eq('id', task.id);

      if (updateError2) throw updateError2;

      console.log('Task completed:', task.id);

      return new Response(JSON.stringify({ success: true, taskId: task.id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Error processing task:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      // Update status to failed
      const { error: updateError3 } = await supabase
        .from('tasks')
        .update({ 
          status: 'failed', 
          result: `Error: ${errorMessage}`,
          agent_thought: 'Task failed'
        })
        .eq('id', task.id);

      if (updateError3) console.error('Failed to update task status:', updateError3);

      return new Response(JSON.stringify({ error: errorMessage, taskId: task.id }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (error) {
    console.error('Error in process-task:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function executeAgentLoop(
  taskId: string, 
  prompt: string, 
  browserlessKey: string, 
  lovableKey: string,
  supabase: any
) {
  console.log("Starting agent loop with prompt:", prompt);
  
  // PHASE 1: URL EXTRACTION AND NAVIGATION
  console.log("Phase 1: Extracting target URL from prompt");
  await supabase
    .from('tasks')
    .update({ agent_thought: 'Analyzing prompt to find target website...' })
    .eq('id', taskId);

  const urlExtractionResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${lovableKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        {
          role: 'system',
          content: `You are a URL extraction assistant. Extract the target website URL from the user's request.
Respond ONLY with a JSON object in this format:
{
  "url": "https://example.com",
  "execution_goal": "The specific task to perform on this website, without navigation instructions"
}

If the prompt mentions a website like "eventbrite.com", return the full URL like "https://eventbrite.com".
For the execution_goal, extract what the user wants to DO on that website, removing all navigation language.
Example: "Go to eventbrite.com and search for tech conferences" -> execution_goal should be "search for tech conferences"`
        },
        {
          role: 'user',
          content: `Extract the target URL and execution goal from this request: "${prompt}"`
        }
      ],
      max_tokens: 200,
    }),
  });

  if (!urlExtractionResponse.ok) {
    throw new Error('Failed to extract URL from prompt');
  }

  const urlData = await urlExtractionResponse.json();
  let urlContent = urlData.choices[0].message.content;
  
  const urlJsonMatch = urlContent.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || 
                       urlContent.match(/(\{[\s\S]*\})/);
  
  if (!urlJsonMatch) {
    throw new Error('Could not parse URL from AI response');
  }

  const { url: targetUrl, execution_goal: executionGoal } = JSON.parse(urlJsonMatch[1]);
  console.log("Extracted target URL:", targetUrl);
  console.log("Execution goal:", executionGoal);

  await supabase
    .from('tasks')
    .update({ agent_thought: `Navigating to ${targetUrl}...` })
    .eq('id', taskId);

  // PHASE 2: TASK EXECUTION WITH PUPPETEER
  console.log("Phase 2: Starting browser automation");
  
  let isDone = false;
  let rawResult = '';
  let iterationCount = 0;
  const MAX_ITERATIONS = 15;
  let previousAction: any = null;
  let identicalScreenshotCount = 0;
  let lastScreenshotHash = '';
  let currentUrl = targetUrl; // Track current page URL
  let actionHistory: string[] = []; // Track all actions taken

  // Build Puppeteer script for browser automation
  const browserlessUrl = `https://production-sfo.browserless.io/chrome?token=${browserlessKey}`;

  while (!isDone && iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    console.log(`Iteration ${iterationCount}/${MAX_ITERATIONS}`);

    await supabase
      .from('tasks')
      .update({ agent_thought: `Step ${iterationCount}: Analyzing page...` })
      .eq('id', taskId);

    // Build script to replay all actions and capture current state
    const stateScript = `
      const browser = await puppeteer.launch();
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 720 });
      
      try {
        console.log("Navigating to ${targetUrl}");
        await page.goto("${targetUrl}", { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(3000); // Wait for page to render
        
        // Replay all previous actions to restore state
        ${actionHistory.map(action => action).join('\n        ')}
        
        // Get current page info
        const pageInfo = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          bodyText: document.body?.innerText?.substring(0, 500) || ''
        }));
        
        // Take screenshot
        const screenshot = await page.screenshot({ 
          type: 'png',
          fullPage: false 
        });
        
        await browser.close();
        
        return {
          screenshot: screenshot.toString('base64'),
          pageInfo
        };
      } catch (error) {
        console.error("Script error:", error);
        await browser.close();
        throw error;
      }
    `;

    const scriptResponse = await fetch(browserlessUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: stateScript,
      }),
    });

    if (!scriptResponse.ok) {
      const errorText = await scriptResponse.text();
      console.error('Browserless error:', errorText);
      
      // If first navigation fails, try one more time
      if (iterationCount === 1) {
        console.log('Retrying navigation...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      throw new Error('Failed to execute browser automation');
    }

    const scriptResult = await scriptResponse.json();
    const base64Screenshot = scriptResult.screenshot;
    const pageInfo = scriptResult.pageInfo;
    
    console.log('Page info:', pageInfo);

    // Check for identical screenshots (page not loading or stuck)
    const currentScreenshotHash = base64Screenshot.substring(0, 200);
    if (currentScreenshotHash === lastScreenshotHash) {
      identicalScreenshotCount++;
      console.log(`Identical screenshot detected (${identicalScreenshotCount}/3)`);
      
      if (identicalScreenshotCount >= 3) {
        // Refresh page once and reset counter
        console.log('Refreshing page due to identical screenshots');
        await fetch(browserlessUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: `
              const browser = await puppeteer.launch();
              const page = await browser.newPage();
              await page.goto("${pageInfo.url}", { waitUntil: 'networkidle2' });
              await page.reload({ waitUntil: 'networkidle2' });
              await page.waitForTimeout(3000);
              await browser.close();
            `,
          }),
        });
        identicalScreenshotCount = 0;
        lastScreenshotHash = '';
        continue;
      }
      
      // Wait and retry
      await new Promise(resolve => setTimeout(resolve, 2000));
      lastScreenshotHash = currentScreenshotHash;
      continue;
    }
    
    lastScreenshotHash = currentScreenshotHash;
    identicalScreenshotCount = 0;

    // Ask Gemini to analyze and determine next action
    await supabase
      .from('tasks')
      .update({ agent_thought: 'Analyzing page and planning next action...' })
      .eq('id', taskId);

    const analysisResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${lovableKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-pro',
        messages: [
          {
            role: 'system',
            content: `You are a web automation agent. Analyze the screenshot and page info, then decide the next action.

IMPORTANT: Respond ONLY with a valid JSON object:
{
  "thought": "Your reasoning",
  "action": {
    "type": "click|type|scroll|done",
    "selector": "CSS selector (for click/type)",
    "text": "Text to type (for type action)",
    "summary": "Human-readable summary (for done action)"
  }
}

Action types:
- click: Click an element (provide CSS selector like "button", "input[type='text']", "#id", ".class")
- type: Type text (provide selector and text)
- scroll: Scroll down to load more content
- done: Task completed - provide a clear, human-readable summary

CRITICAL RULES:
1. For searches: Find the search input box and type the query
2. For reading: Extract the page title and first paragraph
3. For search results: List the top 3 result titles
4. Never repeat the same action twice unless the page changes
5. If stuck, try scrolling or mark as done with what you found
6. Always return human-readable summaries, not raw HTML

You are on step ${iterationCount}/${MAX_ITERATIONS}. Work efficiently.`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Current URL: ${pageInfo.url}
Title: ${pageInfo.title}
Task: "${executionGoal}"

Page text preview: ${pageInfo.bodyText}

What should I do next?`
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64Screenshot}`
                }
              }
            ]
          }
        ],
        max_tokens: 1000,
      }),
    });

    if (!analysisResponse.ok) {
      const errorText = await analysisResponse.text();
      console.error('Gemini API error:', errorText);
      throw new Error('Failed to analyze page');
    }

    const analysisData = await analysisResponse.json();
    let responseContent = analysisData.choices[0].message.content;

    const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || 
                     responseContent.match(/(\{[\s\S]*\})/);
    
    if (!jsonMatch) {
      console.error('Invalid response:', responseContent);
      throw new Error('Agent returned invalid response');
    }

    const agentResponse = JSON.parse(jsonMatch[1]);
    console.log("Agent decision:", agentResponse);

    await supabase
      .from('tasks')
      .update({ agent_thought: agentResponse.thought })
      .eq('id', taskId);

    const action = agentResponse.action;
    
    // Check for repetitive actions
    if (previousAction && 
        JSON.stringify(previousAction) === JSON.stringify(action)) {
      console.log('Same action repeated, marking as done');
      isDone = true;
      rawResult = action.summary || 'Task completed but agent got stuck repeating actions';
      break;
    }
    
    previousAction = { ...action };

    // Execute action
    if (action.type === 'done') {
      isDone = true;
      rawResult = action.summary || '';
      console.log("Task completed:", rawResult);
    } else {
      // Add action to history for replay on next iteration
      let actionCode = '';
      
      if (action.type === 'click') {
        console.log("Clicking:", action.selector);
        const safeSelector = action.selector.replace(/'/g, "\\'");
        actionCode = `
        console.log("Clicking: ${safeSelector}");
        try {
          await page.waitForSelector('${safeSelector}', { timeout: 10000 });
          await page.click('${safeSelector}');
          await page.waitForTimeout(2000);
        } catch (e) {
          console.log("Click failed, continuing:", e.message);
        }`;
      } else if (action.type === 'type') {
        console.log("Typing:", action.text, "into", action.selector);
        const safeSelector = action.selector.replace(/'/g, "\\'");
        const safeText = action.text.replace(/'/g, "\\'").replace(/\n/g, '\\n');
        actionCode = `
        console.log("Typing into: ${safeSelector}");
        try {
          await page.waitForSelector('${safeSelector}', { timeout: 10000 });
          await page.click('${safeSelector}'); // Focus the input
          await page.type('${safeSelector}', '${safeText}');
          await page.keyboard.press('Enter'); // Submit the form
          await page.waitForTimeout(2000);
        } catch (e) {
          console.log("Type failed, continuing:", e.message);
        }`;
      } else if (action.type === 'scroll') {
        console.log("Scrolling page");
        actionCode = `
        console.log("Scrolling page");
        await page.evaluate(() => window.scrollBy(0, 500));
        await page.waitForTimeout(1000);`;
      }

      if (actionCode) {
        actionHistory.push(actionCode);
        currentUrl = pageInfo.url; // Update current URL
      }
    }

    // Small delay between iterations
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (!isDone) {
    throw new Error('Agent reached maximum iterations without completing the task');
  }

  if (!rawResult || rawResult.trim() === '') {
    throw new Error('I was able to visit the page, but I could not find the specific information you asked for.');
  }

  // Final summarization
  await supabase
    .from('tasks')
    .update({ agent_thought: 'Generating final summary...' })
    .eq('id', taskId);

  const summaryResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${lovableKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful AI assistant. Convert the extracted data into a clear, friendly response.'
        },
        {
          role: 'user',
          content: `User requested: "${prompt}"\n\nExtracted data:\n${JSON.stringify(rawResult)}\n\nProvide a friendly, natural language response.`
        }
      ],
      max_tokens: 500,
    }),
  });

  if (!summaryResponse.ok) {
    throw new Error('Failed to generate summary');
  }

  const summaryData = await summaryResponse.json();
  const summary = summaryData.choices[0].message.content;

  console.log("Summary generated:", summary);

  return { summary, rawResult };
}
