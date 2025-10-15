import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages } = await req.json();
    console.log("Received messages:", messages);

    const BROWSERLESS_API_KEY = Deno.env.get('BROWSERLESS_API_KEY');
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');

    if (!BROWSERLESS_API_KEY || !LOVABLE_API_KEY) {
      throw new Error('Required API keys not configured');
    }

    // Connect to Browserless and execute the agent loop
    const result = await executeAgentLoop(messages, BROWSERLESS_API_KEY, LOVABLE_API_KEY);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in web-agent:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function executeAgentLoop(messages: Array<{role: string, content: string}>, browserlessKey: string, lovableKey: string) {
  const latestMessage = messages[messages.length - 1].content;
  console.log("Starting agent loop with conversation history. Latest message:", latestMessage);
  
  // Use Browserless REST API for simpler implementation
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
  
  console.log("Captured initial screenshot");

  // Build conversation history for context
  const conversationContext = messages.slice(-6).map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content
  }));

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
          content: `You are a web automation agent that can see webpages and understand conversational context.

IMPORTANT: Before analyzing the page, check the conversation history:
- If the user's latest message is a confirmation (like "Yes", "Okay", "Please do that", "Go ahead", "Proceed"), they are confirming a previous plan or action you mentioned. In this case, acknowledge their confirmation and proceed with what you previously suggested.
- If the user's message is a new, unrelated command or question, treat it as a fresh task.

Your job is to analyze the screenshot and extract relevant information based on the user's goal, taking into account the conversation history. Be concise and specific.`
        },
        ...conversationContext.slice(0, -1), // Include all but the latest message as history
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Current webpage: http://quotes.toscrape.com/\n\nLatest message: "${latestMessage}"\n\nAnalyze the screenshot and respond appropriately based on the conversation context. If this is a confirmation, acknowledge it and explain what you'll do next. If it's a new request, extract the information needed to accomplish it.`
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
          content: 'You are a helpful AI assistant. Convert technical data into a friendly, natural language response while maintaining conversational context.'
        },
        ...conversationContext.slice(-4), // Include recent context
        {
          role: 'user',
          content: `Based on the conversation above, the user's latest message was: "${latestMessage}"\n\nRaw analysis from the webpage:\n${rawResult}\n\nPlease provide a friendly, natural language response that takes into account the conversation history.`
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
