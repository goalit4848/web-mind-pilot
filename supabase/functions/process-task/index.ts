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
      // Execute agent logic
      const result = await executeAgentLoop(task.prompt, BROWSERLESS_API_KEY, LOVABLE_API_KEY);

      // Update status to completed
      const { error: updateError2 } = await supabase
        .from('tasks')
        .update({ status: 'completed', result: result.summary })
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
        .update({ status: 'failed', result: `Error: ${errorMessage}` })
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

async function executeAgentLoop(prompt: string, browserlessKey: string, lovableKey: string) {
  console.log("Starting agent loop with prompt:", prompt);
  
  // Use Browserless REST API
  const browserlessUrl = `https://production-sfo.browserless.io/screenshot?token=${browserlessKey}`;
  
  // Navigate to the target site
  const initialScreenshot = await fetch(browserlessUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'http://quotes.toscrape.com/',
      options: {
        fullPage: false,
        type: 'png',
      },
    }),
  });

  if (!initialScreenshot.ok) {
    throw new Error('Failed to capture initial screenshot');
  }

  const screenshotBuffer = await initialScreenshot.arrayBuffer();
  const base64Screenshot = btoa(String.fromCharCode(...new Uint8Array(screenshotBuffer)));
  
  console.log("Captured screenshot");

  // Use Gemini Pro for vision analysis
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
          content: 'You are a web automation agent that can see webpages. Analyze the screenshot and extract relevant information based on the user\'s request. Be concise and specific.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Current webpage: http://quotes.toscrape.com/\n\nUser request: "${prompt}"\n\nAnalyze the screenshot and respond to the user's request.`
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
  const rawResult = analysisData.choices[0].message.content;
  
  console.log("Analysis complete:", rawResult);

  // Use Gemini Flash for natural language summary
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
          content: 'You are a helpful AI assistant. Convert technical data into a friendly, natural language response.'
        },
        {
          role: 'user',
          content: `User requested: "${prompt}"\n\nRaw analysis from the webpage:\n${rawResult}\n\nPlease provide a friendly, natural language response.`
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
