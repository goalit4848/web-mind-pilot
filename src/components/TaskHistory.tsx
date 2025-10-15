import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Clock, CheckCircle2, XCircle, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface Task {
  id: string;
  prompt: string;
  status: string;
  result: string | null;
  created_at: string;
}

interface TaskHistoryProps {
  userId: string;
  onTaskClick: (task: Task) => void;
}

export const TaskHistory = ({ userId, onTaskClick }: TaskHistoryProps) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    // Fetch initial tasks
    const fetchTasks = async () => {
      const { data, error } = await supabase
        .from('tasks')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching tasks:', error);
      } else {
        setTasks(data || []);
      }
    };

    fetchTasks();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('tasks-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          console.log('Task update:', payload);
          if (payload.eventType === 'INSERT') {
            setTasks((prev) => [payload.new as Task, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            setTasks((prev) =>
              prev.map((task) =>
                task.id === payload.new.id ? (payload.new as Task) : task
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return <Clock className="w-4 h-4 text-muted-foreground" />;
      case 'running':
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'failed':
        return <XCircle className="w-4 h-4 text-destructive" />;
      default:
        return null;
    }
  };

  return (
    <div
      className={cn(
        "h-full border-r border-border/50 bg-card/40 backdrop-blur-sm transition-all duration-300",
        isCollapsed ? "w-12" : "w-80"
      )}
    >
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border/50">
          {!isCollapsed && (
            <h2 className="text-lg font-semibold bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
              Task History
            </h2>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="ml-auto"
          >
            {isCollapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </Button>
        </div>

        {/* Task List */}
        {!isCollapsed && (
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-2">
              {tasks.length === 0 ? (
                <div className="text-center text-muted-foreground text-sm py-8">
                  No tasks yet
                </div>
              ) : (
                tasks.map((task) => (
                  <button
                    key={task.id}
                    onClick={() => task.status === 'completed' && onTaskClick(task)}
                    disabled={task.status !== 'completed'}
                    className={cn(
                      "w-full text-left p-3 rounded-lg border border-border/50 transition-all duration-200",
                      "hover:bg-card/60 hover:border-primary/50",
                      task.status === 'completed' && "cursor-pointer",
                      task.status !== 'completed' && "cursor-default opacity-70"
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5">{getStatusIcon(task.status)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{task.prompt}</p>
                        <p className="text-xs text-muted-foreground capitalize mt-1">
                          {task.status}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {new Date(task.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
};
