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
  console.log("Starting web automation for prompt:", prompt);
  
  // PHASE 1: URL EXTRACTION
  console.log("Phase 1: Extracting target URL from prompt");
  await supabase
    .from('tasks')
    .update({ agent_thought: 'Understanding your request...' })
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
          content: `Extract the target URL from the user's request. Respond ONLY with JSON:
{
  "url": "https://example.com"
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
    return { 
      summary: "I couldn't understand the URL from your request. Please specify a valid website.",
      rawResult: null
    };
  }

  const urlData = await urlExtractionResponse.json();
  const urlContent = urlData.choices[0].message.content;
  const urlMatch = urlContent.match(/\{[\s\S]*\}/);
  
  if (!urlMatch) {
    return { 
      summary: "I couldn't parse the website URL from your request.",
      rawResult: null
    };
  }

  const { url: targetUrl } = JSON.parse(urlMatch[0]);
  console.log("Target URL:", targetUrl);

  await supabase
    .from('tasks')
    .update({ agent_thought: `Visiting ${targetUrl}...` })
    .eq('id', taskId);

  // PHASE 2: VISIT THE PAGE WITH SMART RETRIES
  console.log("Phase 2: Visiting the page");
  
  const browserlessUrl = `https://chrome.browserless.io/content?token=${browserlessKey}`;
  const MAX_RETRIES = 2;
  let attempt = 0;
  let pageContent = null;

  while (attempt <= MAX_RETRIES && !pageContent) {
    if (attempt > 0) {
      console.log(`Retry attempt ${attempt}/${MAX_RETRIES}`);
      await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay between retries
    }

    try {
      const browserlessResponse = await fetch(browserlessUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          gotoOptions: { 
            waitUntil: 'networkidle0', 
            timeout: 40000 
          },
          waitForTimeout: 3000,
          elements: [
            { selector: 'title', action: 'text' },
            { selector: 'h1', action: 'text' },
            { selector: 'h2', action: 'text' },
            { selector: 'p', action: 'text' }
          ]
        }),
      });

      if (!browserlessResponse.ok) {
        const errorText = await browserlessResponse.text();
        console.error(`Browserless error (attempt ${attempt + 1}):`, errorText);
        attempt++;
        continue;
      }

      const data = await browserlessResponse.json();
      
      // Check if we got meaningful content
      if (data && (data.data || data.html || data.elements)) {
        pageContent = data;
        console.log('Page loaded successfully');
      } else {
        console.log('Page returned empty content, retrying...');
        attempt++;
      }
    } catch (error) {
      console.error(`Fetch error (attempt ${attempt + 1}):`, error);
      attempt++;
    }
  }

  if (!pageContent) {
    return { 
      summary: "The page didn't load after retries.",
      rawResult: null
    };
  }

  // PHASE 3: ANALYZE AND SUMMARIZE
  await supabase
    .from('tasks')
    .update({ agent_thought: 'Reading the page content...' })
    .eq('id', taskId);

  // Extract text from elements
  const extractedText: {
    title: string;
    headings: string[];
    paragraphs: string[];
  } = {
    title: '',
    headings: [],
    paragraphs: []
  };

  if (pageContent.elements) {
    pageContent.elements.forEach((el: any) => {
      if (el.selector === 'title' && el.text) {
        extractedText.title = el.text.trim();
      } else if ((el.selector === 'h1' || el.selector === 'h2') && el.text) {
        extractedText.headings.push(el.text.trim());
      } else if (el.selector === 'p' && el.text) {
        extractedText.paragraphs.push(el.text.trim());
      }
    });
  }

  // Limit text for API call
  const headingsText = extractedText.headings.slice(0, 5).join('\n');
  const paragraphsText = extractedText.paragraphs.slice(0, 3).join('\n').substring(0, 1000);

  const analysisResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
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
          content: `You are a web automation assistant. Summarize what you see on web pages in plain, human-readable language.

RULES:
- Write like a human would describe what they see
- For regular pages: mention the title and main content in 1-2 sentences
- For search results: list the top 3-5 results with brief descriptions
- Never output JSON, code, or HTML
- Keep it conversational and clear
- If the page is blank or unclear, say "The page didn't load correctly"

EXAMPLES:
User asked to visit example.com:
"The page is titled 'Example Domain.' It explains that this domain is for use in illustrative examples in documents."

User asked to search Google for "AI tools":
"I visited Google and searched for AI tools. Here are the top results:
• FutureTools - A collection of the best AI tools
• Product Hunt AI - New AI tools and products
• OpenAI - The creators of ChatGPT"`
        },
        {
          role: 'user',
          content: `User asked: "${prompt}"

I visited: ${targetUrl}
Page title: ${extractedText.title || 'Unknown'}
Main headings: ${headingsText || 'None found'}
First paragraphs: ${paragraphsText || 'None found'}

Please provide a clear, human-readable summary.`
        }
      ],
      max_tokens: 500,
    }),
  });

  if (!analysisResponse.ok) {
    const errorText = await analysisResponse.text();
    console.error('Gemini API error:', errorText);
    // Fallback to basic summary
    const firstParagraph = extractedText.paragraphs[0] || 'No content found';
    return {
      summary: `I visited ${extractedText.title || targetUrl}. ${firstParagraph.substring(0, 200)}`,
      rawResult: JSON.stringify(extractedText)
    };
  }

  const analysisData = await analysisResponse.json();
  const summary = analysisData.choices[0].message.content;

  console.log("Summary generated:", summary);

  return { 
    summary, 
    rawResult: JSON.stringify(extractedText) 
  };
}
