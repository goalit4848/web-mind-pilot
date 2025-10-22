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
  console.log("Starting smart web automation for prompt:", prompt);
  
  // Track execution metadata
  const executionLog = {
    actions_taken: [] as string[],
    url: '',
    title: '',
    screenshot_checks: [] as string[],
  };
  
  // PHASE 1: URL EXTRACTION
  console.log("Phase 1: Extracting target URL from prompt");
  await supabase
    .from('tasks')
    .update({ agent_thought: 'Analyzing your request...' })
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
          content: `Extract the target URL and task from the user's request. Respond ONLY with JSON:
{
  "url": "https://example.com",
  "task": "what to do on this website"
}`
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 200,
    }),
  });

  if (!urlExtractionResponse.ok) {
    throw new Error('Failed to extract URL from prompt');
  }

  const urlData = await urlExtractionResponse.json();
  const urlContent = urlData.choices[0].message.content;
  const urlMatch = urlContent.match(/\{[\s\S]*\}/);
  
  if (!urlMatch) {
    throw new Error('Could not parse URL from response');
  }

  const { url: targetUrl, task: executionTask } = JSON.parse(urlMatch[0]);
  console.log("Target URL:", targetUrl, "Task:", executionTask);
  executionLog.url = targetUrl;
  executionLog.actions_taken.push('analyzed_request');

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
    
    // Detect if screenshot is likely black/empty (very low variation in first bytes)
    const isLikelyBlack = base64Screenshot.substring(0, 500).split('').filter((c: string, i: number, arr: string[]) => 
      i > 0 && c !== arr[i-1]
    ).length < 10;
    
    if (isLikelyBlack) {
      console.log('Screenshot appears black or empty');
      executionLog.screenshot_checks.push('black');
      
      if (identicalScreenshotCount >= 2) {
        // Reload once and retry
        console.log('Reloading page due to black screenshot');
        executionLog.actions_taken.push('page_reload');
        await fetch(browserlessUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: `
              const browser = await puppeteer.launch();
              const page = await browser.newPage();
              await page.goto("${targetUrl}", { waitUntil: 'networkidle2' });
              await page.reload({ waitUntil: 'networkidle2' });
              await page.waitForTimeout(3000);
              await browser.close();
            `,
          }),
        });
        identicalScreenshotCount = 0;
        lastScreenshotHash = '';
        actionHistory = []; // Reset action history after reload
        continue;
      }
      identicalScreenshotCount++;
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    
    if (currentScreenshotHash === lastScreenshotHash) {
      identicalScreenshotCount++;
      console.log(`Identical screenshot detected (${identicalScreenshotCount}/2)`);
      executionLog.screenshot_checks.push('same');
      
      if (identicalScreenshotCount >= 2) {
        // Reload once and reset counter
        console.log('Reloading page due to identical screenshots');
        executionLog.actions_taken.push('page_reload');
        await fetch(browserlessUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: `
              const browser = await puppeteer.launch();
              const page = await browser.newPage();
              await page.goto("${pageInfo.url || targetUrl}", { waitUntil: 'networkidle2' });
              await page.reload({ waitUntil: 'networkidle2' });
              await page.waitForTimeout(3000);
              await browser.close();
            `,
          }),
        });
        identicalScreenshotCount = 0;
        lastScreenshotHash = '';
        actionHistory = []; // Reset action history after reload
        continue;
      }
      
      // Wait and retry
      await new Promise(resolve => setTimeout(resolve, 2000));
      lastScreenshotHash = currentScreenshotHash;
      continue;
    }
    
    lastScreenshotHash = currentScreenshotHash;
    identicalScreenshotCount = 0;
    executionLog.screenshot_checks.push('ok');
    
    // Store page title if we haven't yet
    if (!executionLog.title && pageInfo.title) {
      executionLog.title = pageInfo.title;
    }

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
            content: `You are a smart web automation agent. Your job is to visit websites, interact naturally, and provide clear readable summaries.

RESPOND ONLY with valid JSON in this format:
{
  "description": "What you're about to do",
  "action": {
    "type": "click|type|scroll|done",
    "selector": "CSS selector (for click/type)",
    "text": "Text to type (for type action)",
    "summary": "Human-readable summary (for done action)"
  }
}

EXECUTION RULES:
1. Always describe what you're about to do in "description"
2. Before clicking/typing, verify the element exists on the page
3. Never repeat the same action more than twice
4. For searches: Find search input, type query, submit
5. For reading: Extract title + first visible paragraph
6. For search results: List top 3 result titles with brief descriptions
7. If stuck or unclear, scroll once then mark as done with what you found

ACTION TYPES:
- click: Click button/link (provide CSS selector)
- type: Type into input field (provide selector + text, will auto-submit)
- scroll: Scroll down to load more content
- done: Task complete - provide human-readable summary

OUTPUT REQUIREMENTS:
- Summary must be conversational and clear
- List results as bullet points when applicable
- Never output raw HTML or code
- If can't find info, say so clearly

Step ${iterationCount}/${MAX_ITERATIONS}. Work efficiently and avoid loops.`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Current URL: ${pageInfo.url}
Title: ${pageInfo.title}
Task: "${executionTask}"

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
    const description = agentResponse.description || agentResponse.thought || 'Processing...';
    console.log("Agent description:", description);
    console.log("Agent action:", agentResponse.action);

    // Update agent thought with description
    await supabase
      .from('tasks')
      .update({ agent_thought: description })
      .eq('id', taskId);

    const action = agentResponse.action;
    
    // Check for repetitive actions (max 2 times)
    if (previousAction && 
        JSON.stringify(previousAction) === JSON.stringify(action)) {
      console.log('Same action repeated twice, marking as done');
      isDone = true;
      rawResult = JSON.stringify({
        status: 'success',
        url: pageInfo.url,
        title: pageInfo.title || executionLog.title,
        summary: action.summary || 'Task completed with available information',
        actions_taken: executionLog.actions_taken,
        screenshot_check: 'ok'
      });
      break;
    }
    
    previousAction = { ...action };

    // Execute action
    if (action.type === 'done') {
      isDone = true;
      executionLog.actions_taken.push('completed');
      rawResult = JSON.stringify({
        status: 'success',
        url: pageInfo.url,
        title: pageInfo.title || executionLog.title,
        summary: action.summary || 'Task completed',
        actions_taken: executionLog.actions_taken,
        screenshot_check: executionLog.screenshot_checks[executionLog.screenshot_checks.length - 1] || 'ok'
      });
      console.log("Task completed with result:", rawResult);
    } else {
      // Add action to history for replay on next iteration
      let actionCode = '';
      
      if (action.type === 'click') {
        console.log("Planning to click:", action.selector);
        executionLog.actions_taken.push(`clicked:${action.selector}`);
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
        console.log("Planning to type:", action.text, "into", action.selector);
        executionLog.actions_taken.push(`typed:${action.text.substring(0, 20)}`);
        const safeSelector = action.selector.replace(/'/g, "\\'");
        const safeText = (action.text || '').replace(/'/g, "\\'").replace(/\n/g, '\\n');
        actionCode = `
        console.log("Typing into: ${safeSelector}");
        try {
          await page.waitForSelector('${safeSelector}', { timeout: 10000 });
          await page.click('${safeSelector}'); // Focus the input
          await page.type('${safeSelector}', '${safeText}');
          await page.keyboard.press('Enter'); // Submit the form
          await page.waitForTimeout(3000); // Wait for results
        } catch (e) {
          console.log("Type failed, continuing:", e.message);
        }`;
      } else if (action.type === 'scroll') {
        console.log("Planning to scroll page");
        executionLog.actions_taken.push('scrolled');
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
    // Return structured error JSON
    const errorResult = JSON.stringify({
      status: 'error',
      url: executionLog.url,
      title: executionLog.title,
      summary: 'The task could not be completed within the step limit. The page may be too complex or the task unclear.',
      actions_taken: executionLog.actions_taken,
      screenshot_check: executionLog.screenshot_checks[executionLog.screenshot_checks.length - 1] || 'unknown'
    });
    throw new Error(errorResult);
  }

  // Parse and validate the result
  let resultData;
  try {
    resultData = JSON.parse(rawResult);
  } catch (e) {
    // If rawResult is not JSON, wrap it
    resultData = {
      status: 'success',
      url: executionLog.url,
      title: executionLog.title,
      summary: rawResult,
      actions_taken: executionLog.actions_taken,
      screenshot_check: 'ok'
    };
    rawResult = JSON.stringify(resultData);
  }

  if (!resultData.summary || resultData.summary.trim() === '') {
    const errorResult = JSON.stringify({
      status: 'error',
      url: executionLog.url,
      title: executionLog.title,
      summary: 'I was able to visit the page, but could not find the specific information you requested.',
      actions_taken: executionLog.actions_taken,
      screenshot_check: resultData.screenshot_check || 'ok'
    });
    throw new Error(errorResult);
  }

  // Final summarization - convert JSON result to friendly text
  await supabase
    .from('tasks')
    .update({ agent_thought: 'Formatting final response...' })
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
          content: 'You are a helpful AI assistant. Convert the structured data into a clear, conversational response. Keep it brief and friendly.'
        },
        {
          role: 'user',
          content: `User requested: "${prompt}"\n\nResult data:\n${rawResult}\n\nProvide a friendly, natural language summary.`
        }
      ],
      max_tokens: 500,
    }),
  });

  if (!summaryResponse.ok) {
    // If summarization fails, return the JSON summary directly
    return { summary: resultData.summary, rawResult };
  }

  const summaryData = await summaryResponse.json();
  const summary = summaryData.choices[0].message.content;

  console.log("Final summary generated:", summary);

  return { summary, rawResult };
}
