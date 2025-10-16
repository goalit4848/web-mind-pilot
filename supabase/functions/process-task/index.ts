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

  // Take initial screenshot of target URL
  const browserlessUrl = `https://production-sfo.browserless.io/screenshot?token=${browserlessKey}`;
  const initialScreenshotResponse = await fetch(browserlessUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      options: {
        fullPage: false,
        type: 'png',
      },
    }),
  });

  if (!initialScreenshotResponse.ok) {
    throw new Error('Failed to navigate to target URL');
  }

  console.log("Successfully navigated to target URL");
  await supabase
    .from('tasks')
    .update({ agent_thought: `Arrived at ${targetUrl}. Beginning task execution...` })
    .eq('id', taskId);

  // Small delay before starting execution phase
  await new Promise(resolve => setTimeout(resolve, 1000));

  // PHASE 2: TASK EXECUTION
  console.log("Phase 2: Starting task execution");
  let currentUrl = targetUrl;
  let isDone = false;
  let rawResult = '';
  let iterationCount = 0;
  const MAX_ITERATIONS = 15;
  let previousAction: any = null;
  let previousScreenshotHash = '';

  while (!isDone) {
    iterationCount++;
    
    // Safety check: Step limit
    if (iterationCount > MAX_ITERATIONS) {
      throw new Error('Agent exceeded the maximum step limit without completing the task');
    }
    
    console.log(`Iteration ${iterationCount}: Taking screenshot of ${currentUrl}`);

    // Update agent thought
    await supabase
      .from('tasks')
      .update({ agent_thought: `Taking screenshot of ${currentUrl}...` })
      .eq('id', taskId);

    // Capture screenshot
    const screenshotResponse = await fetch(browserlessUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentUrl,
        options: {
          fullPage: false,
          type: 'png',
        },
      }),
    });

    if (!screenshotResponse.ok) {
      throw new Error('Failed to capture screenshot');
    }

    const screenshotBuffer = await screenshotResponse.arrayBuffer();
    const base64Screenshot = btoa(String.fromCharCode(...new Uint8Array(screenshotBuffer)));
    
    // Create a simple hash of the screenshot for comparison
    const currentScreenshotHash = base64Screenshot.substring(0, 100);

    // Update agent thought
    await supabase
      .from('tasks')
      .update({ agent_thought: 'Analyzing screenshot...' })
      .eq('id', taskId);

    // Ask Gemini to analyze and determine next action
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
          content: `You are a web automation agent. You have already navigated to the target website. Now analyze the screenshot and determine the next action to achieve the user's goal.

IMPORTANT: Respond ONLY with a valid JSON object in this exact format:
{
  "thought": "Your reasoning about what you see and what to do next",
  "action": {
    "type": "click|type|scroll|done",
    "selector": "CSS selector (for click/type actions)",
    "text": "Text to type (for type action)",
    "raw_result": "The extracted data (ONLY for done action)"
  }
}

Action types (NOTE: You are already on the correct page, do NOT use navigate):
- click: Click an element (provide CSS selector)
- type: Type text into an input (provide CSS selector and text)
- scroll: Scroll the page
- done: Goal achieved, provide the extracted data in raw_result

Current iteration: ${iterationCount}/${MAX_ITERATIONS}
WARNING: You are approaching the step limit. Work efficiently to complete the goal.`
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are currently on: ${currentUrl}\n\nYour task: "${executionGoal}"\n\nWhat should I do next? Respond with JSON only.`
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
      throw new Error(`Failed to analyze screenshot: ${errorText}`);
    }

    const analysisData = await analysisResponse.json();
    let responseContent = analysisData.choices[0].message.content;

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = responseContent.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || 
                     responseContent.match(/(\{[\s\S]*\})/);
    
    if (!jsonMatch) {
      console.error('Failed to parse JSON from response:', responseContent);
      throw new Error('Agent returned invalid response format');
    }

    const agentResponse = JSON.parse(jsonMatch[1]);
    console.log("Agent response:", agentResponse);

    // Update agent thought
    await supabase
      .from('tasks')
      .update({ agent_thought: agentResponse.thought })
      .eq('id', taskId);

    // Execute the action
    const action = agentResponse.action;
    
    // Safety check: Repetition detection
    if (previousAction && 
        JSON.stringify(previousAction) === JSON.stringify(action) &&
        previousScreenshotHash === currentScreenshotHash) {
      throw new Error('Agent got stuck in a repetitive loop - same action with no page changes detected');
    }
    
    // Update tracking variables
    previousAction = { ...action };
    previousScreenshotHash = currentScreenshotHash;

    if (action.type === 'done') {
      isDone = true;
      rawResult = action.raw_result || '';
      console.log("Agent completed task with result:", rawResult);
    } else if (action.type === 'click') {
      console.log("Would click:", action.selector);
      // Note: Browserless screenshot API doesn't support interactions
      // In a real implementation, you'd use Puppeteer or Playwright
    } else if (action.type === 'type') {
      console.log("Would type:", action.text, "into", action.selector);
      // Note: Same limitation as click
    } else if (action.type === 'scroll') {
      console.log("Would scroll the page");
      // Note: Same limitation as click
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
