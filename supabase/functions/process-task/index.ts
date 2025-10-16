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
  
  const browserlessUrl = `https://production-sfo.browserless.io/screenshot?token=${browserlessKey}`;
  let currentUrl = 'http://quotes.toscrape.com/';
  let isDone = false;
  let rawResult = '';
  let iterationCount = 0;
  const MAX_ITERATIONS = 10;

  while (!isDone && iterationCount < MAX_ITERATIONS) {
    iterationCount++;
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
            content: `You are a web automation agent. Analyze the screenshot and determine the next action to achieve the user's goal.

IMPORTANT: Respond ONLY with a valid JSON object in this exact format:
{
  "thought": "Your reasoning about what you see and what to do next",
  "action": {
    "type": "navigate|click|type|scroll|done",
    "url": "URL to navigate to (for navigate action)",
    "selector": "CSS selector (for click/type actions)",
    "text": "Text to type (for type action)",
    "raw_result": "The extracted data (ONLY for done action)"
  }
}

Action types:
- navigate: Go to a new URL
- click: Click an element (provide CSS selector)
- type: Type text into an input (provide CSS selector and text)
- scroll: Scroll the page
- done: Goal achieved, provide the extracted data in raw_result

Current iteration: ${iterationCount}/${MAX_ITERATIONS}`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Current URL: ${currentUrl}\n\nUser's goal: "${prompt}"\n\nWhat should I do next? Respond with JSON only.`
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

    if (action.type === 'done') {
      isDone = true;
      rawResult = action.raw_result || '';
      console.log("Agent completed task with result:", rawResult);
    } else if (action.type === 'navigate') {
      currentUrl = action.url;
      console.log("Navigating to:", currentUrl);
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
