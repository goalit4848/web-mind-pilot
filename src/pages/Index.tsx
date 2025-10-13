import { useState } from "react";
import { ChatMessage } from "@/components/ChatMessage";
import { AgentStatus } from "@/components/AgentStatus";
import { ChatInput } from "@/components/ChatInput";
import { Bot } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface Message {
  role: "user" | "agent";
  content: string;
}

const Index = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentStatus, setAgentStatus] = useState("Idle");
  const [isProcessing, setIsProcessing] = useState(false);
  const { toast } = useToast();

  const handleSend = async (message: string) => {
    // Add user message
    setMessages(prev => [...prev, { role: "user", content: message }]);
    setIsProcessing(true);
    setAgentStatus("Starting browser session...");

    try {
      const { data, error } = await supabase.functions.invoke("web-agent", {
        body: { command: message },
      });

      if (error) throw error;

      // Add agent response
      setMessages(prev => [...prev, { role: "agent", content: data.summary }]);
      setAgentStatus("Task completed");
      
      toast({
        title: "Task Completed",
        description: "The agent has finished processing your request.",
      });
    } catch (error) {
      console.error("Error:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to process request",
        variant: "destructive",
      });
      setAgentStatus("Error occurred");
    } finally {
      setIsProcessing(false);
      setTimeout(() => setAgentStatus("Idle"), 2000);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border/50 backdrop-blur-md bg-card/30">
        <div className="container mx-auto px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Bot className="w-8 h-8 text-primary" />
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-accent rounded-full animate-pulse-glow" />
            </div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              AI Web Agent
            </h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 container mx-auto px-6 py-8 flex flex-col gap-6 max-w-6xl">
        {/* Agent Status */}
        <AgentStatus status={agentStatus} isActive={isProcessing} />

        {/* Messages Area */}
        <div className="flex-1 bg-card/40 backdrop-blur-sm rounded-2xl border border-border/50 p-6 overflow-y-auto min-h-[400px] shadow-inner">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <div className="text-center space-y-3">
                <Bot className="w-16 h-16 mx-auto opacity-50" />
                <p className="text-lg">Ready to help! Send a command to get started.</p>
                <p className="text-sm">Example: "Find the top 3 quotes on the page"</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {messages.map((msg, idx) => (
                <ChatMessage key={idx} role={msg.role} content={msg.content} />
              ))}
            </div>
          )}
        </div>

        {/* Input Area */}
        <ChatInput onSend={handleSend} disabled={isProcessing} />
      </main>
    </div>
  );
};

export default Index;
