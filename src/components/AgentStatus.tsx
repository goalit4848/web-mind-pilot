import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface AgentStatusProps {
  status: string;
  isActive: boolean;
}

export const AgentStatus = ({ status, isActive }: AgentStatusProps) => {
  return (
    <div className="w-full bg-card/60 backdrop-blur-md rounded-2xl p-6 border border-border/50 shadow-lg">
      <div className="flex items-center gap-3 mb-3">
        <div className={cn(
          "w-3 h-3 rounded-full transition-all duration-300",
          isActive ? "bg-accent animate-pulse-glow" : "bg-muted"
        )} />
        <h3 className="text-sm font-semibold text-foreground uppercase tracking-wide">Agent Status</h3>
      </div>
      
      <div className="flex items-center gap-3 mt-4">
        {isActive && <Loader2 className="w-5 h-5 text-accent animate-spin" />}
        <p className={cn(
          "text-sm transition-all duration-300",
          isActive ? "text-foreground font-medium" : "text-muted-foreground"
        )}>
          {status}
        </p>
      </div>
    </div>
  );
};
