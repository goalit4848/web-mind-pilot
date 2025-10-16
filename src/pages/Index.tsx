import { useState, useEffect } from "react";
import { ChatMessage } from "@/components/ChatMessage";
import { AgentStatus } from "@/components/AgentStatus";
import { ChatInput } from "@/components/ChatInput";
import { TaskHistory } from "@/components/TaskHistory";
import { Bot } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

interface Message {
  role: "user" | "agent";
  content: string;
}

interface Task {
  id: string;
  prompt: string;
  status: string;
  result: string | null;
  agent_thought?: string | null;
  created_at: string;
}

const Index = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentStatus, setAgentStatus] = useState("Idle");
  const [isProcessing, setIsProcessing] = useState(false);
  const [userId, setUserId] = useState<string>("");
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const { toast } = useToast();

  // Generate or retrieve session ID for this user
  useEffect(() => {
    let sessionId = localStorage.getItem('agent-session-id');
    if (!sessionId) {
      sessionId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem('agent-session-id', sessionId);
    }
    setUserId(sessionId);
  }, []);

  // Subscribe to real-time task updates for agent status
  useEffect(() => {
    if (!currentTaskId) return;

    const channel = supabase
      .channel('task-updates')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'tasks',
          filter: `id=eq.${currentTaskId}`
        },
        (payload) => {
          const updatedTask = payload.new as Task;
          if (updatedTask.agent_thought) {
            setAgentStatus(updatedTask.agent_thought);
          }
          if (updatedTask.status === 'completed' || updatedTask.status === 'failed') {
            setIsProcessing(false);
            setCurrentTaskId(null);
            if (updatedTask.result) {
              setMessages(prev => [...prev, { role: "agent", content: updatedTask.result }]);
            }
            setAgentStatus("Idle");
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentTaskId]);

  const handleSend = async (message: string) => {
    if (!userId) return;

    // Add user message to UI
    const newUserMessage = { role: "user" as const, content: message };
    setMessages(prev => [...prev, newUserMessage]);
    setIsProcessing(true);
    setAgentStatus("Creating task...");

    try {
      // Create task in database
      const { data: task, error: insertError } = await supabase
        .from('tasks')
        .insert({
          user_id: userId,
          prompt: message,
          status: 'pending',
        })
        .select()
        .single();

      if (insertError) throw insertError;

      setCurrentTaskId(task.id);
      setAgentStatus("Task queued, starting agent...");
      
      toast({
        title: "Task Created",
        description: "Your task is queued and will be processed shortly.",
      });

      // Trigger the worker to process the task
      setTimeout(async () => {
        try {
          await supabase.functions.invoke("process-task");
        } catch (error) {
          console.error("Error invoking worker:", error);
        }
      }, 500);

    } catch (error) {
      console.error("Error:", error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to create task",
        variant: "destructive",
      });
      setAgentStatus("Error occurred");
      setIsProcessing(false);
      setCurrentTaskId(null);
    }
  };

  const handleTaskClick = (task: Task) => {
    if (task.result) {
      setMessages([
        { role: "user", content: task.prompt },
        { role: "agent", content: task.result },
      ]);
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

      {/* Main Content with History Panel */}
      <main className="flex-1 flex overflow-hidden">
        {/* Task History Panel */}
        {userId && <TaskHistory userId={userId} onTaskClick={handleTaskClick} />}

        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col">
          <div className="container mx-auto px-6 py-8 flex flex-col gap-6 max-w-6xl h-full">
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
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
