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
  console.log("Starting simple web automation for prompt:", prompt);
  
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
    return { 
      summary: "I couldn't understand the URL from your request. Please specify a valid website like google.com or example.com.",
      rawResult: null
    };
  }

  const urlData = await urlExtractionResponse.json();
  const urlContent = urlData.choices[0].message.content;
  const urlMatch = urlContent.match(/\{[\s\S]*\}/);
  
  if (!urlMatch) {
    return { 
      summary: "I couldn't parse the website URL from your request. Please specify a clear URL.",
      rawResult: null
    };
  }

  const { url: targetUrl, task: executionTask } = JSON.parse(urlMatch[0]);
  console.log("Target URL:", targetUrl, "Task:", executionTask);

  await supabase
    .from('tasks')
    .update({ agent_thought: `Visiting ${targetUrl}...` })
    .eq('id', taskId);

  // PHASE 2: VISIT AND READ THE PAGE
  console.log("Phase 2: Visiting the page");
  
  const browserlessUrl = `https://production-sfo.browserless.io/chrome?token=${browserlessKey}`;

  // Simple script: navigate, wait, screenshot, extract text
  const visitScript = `
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    
    try {
      console.log("Navigating to ${targetUrl}");
      await page.goto("${targetUrl}", { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Wait 3 seconds for page to fully render
      await page.waitForTimeout(3000);
      
      // Get page info
      const pageInfo = await page.evaluate(() => {
        // Extract visible text from the page
        const getVisibleText = () => {
          const bodyText = document.body?.innerText || '';
          const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
            .map(h => h.textContent?.trim())
            .filter(t => t)
            .slice(0, 5);
          
          return {
            title: document.title,
            headings: headings,
            firstParagraph: bodyText.split('\\n').filter(line => line.length > 50)[0] || bodyText.substring(0, 300),
            fullText: bodyText.substring(0, 2000)
          };
        };
        
        return {
          url: window.location.href,
          ...getVisibleText()
        };
      });
      
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
      console.error("Navigation error:", error);
      await browser.close();
      throw error;
    }
  `;

  let scriptResponse;
  try {
    scriptResponse = await fetch(browserlessUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: visitScript }),
    });
  } catch (error) {
    console.error('Browserless fetch error:', error);
    return { 
      summary: "The page didn't load correctly. The website may be down or unreachable.",
      rawResult: null
    };
  }

  if (!scriptResponse.ok) {
    const errorText = await scriptResponse.text();
    console.error('Browserless error:', errorText);
    return { 
      summary: "The page didn't load correctly. The website may have blocked the request or timed out.",
      rawResult: null
    };
  }

  const scriptResult = await scriptResponse.json();
  const base64Screenshot = scriptResult.screenshot;
  const pageInfo = scriptResult.pageInfo;
  
  console.log('Page loaded successfully:', pageInfo.title);

  // Check if screenshot is likely black/empty
  const isLikelyBlack = base64Screenshot.substring(0, 500).split('').filter((c: string, i: number, arr: string[]) => 
    i > 0 && c !== arr[i-1]
  ).length < 10;
  
  if (isLikelyBlack) {
    console.log('Screenshot appears black or empty');
    return { 
      summary: "The page didn't load correctly. I could navigate to it, but the content didn't render properly.",
      rawResult: null
    };
  }

  // PHASE 3: ANALYZE AND SUMMARIZE
  await supabase
    .from('tasks')
    .update({ agent_thought: 'Reading the page content...' })
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
          content: `You are a web automation assistant. Your job is to read websites and summarize what you see in plain, human-readable language.

RULES:
- Write like a human would describe what they see
- For regular pages: mention the title and main content
- For search results: list the top 3-5 results with brief descriptions
- Never output JSON, code, or HTML
- Keep it conversational and clear
- If the page is blank or unclear, say "The page didn't load correctly"

EXAMPLES:
User asked to visit example.com:
"The page is titled 'Example Domain.' It explains that this domain is for use in illustrative examples in documents."

User asked to search Google for "AI tools":
"I visited Google and searched for AI tools. Here are the top results:
• FutureTools - A collection of the best AI tools and software
• Product Hunt AI - New AI tools and products
• OpenAI - The creators of ChatGPT and GPT-4"`
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `User asked: "${prompt}"

I visited: ${pageInfo.url}
Page title: ${pageInfo.title}
Main headings: ${pageInfo.headings.join(', ')}
First paragraph: ${pageInfo.firstParagraph}

Full page text preview:
${pageInfo.fullText}

Please provide a clear, human-readable summary of what you found.`
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
      max_tokens: 500,
    }),
  });

  if (!analysisResponse.ok) {
    const errorText = await analysisResponse.text();
    console.error('Gemini API error:', errorText);
    // Fallback to basic summary
    return {
      summary: `I visited ${pageInfo.title || targetUrl}. ${pageInfo.firstParagraph}`,
      rawResult: JSON.stringify(pageInfo)
    };
  }

  const analysisData = await analysisResponse.json();
  const summary = analysisData.choices[0].message.content;

  console.log("Summary generated:", summary);

  return { 
    summary, 
    rawResult: JSON.stringify(pageInfo) 
  };
}
