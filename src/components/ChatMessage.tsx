import { cn } from "@/lib/utils";

interface ChatMessageProps {
  role: "user" | "agent";
  content: string;
}

export const ChatMessage = ({ role, content }: ChatMessageProps) => {
  const isUser = role === "user";
  
  return (
    <div className={cn("flex w-full mb-4 animate-in fade-in slide-in-from-bottom-2 duration-500", isUser ? "justify-end" : "justify-start")}>
      <div className={cn(
        "max-w-[80%] rounded-2xl px-6 py-4 shadow-lg backdrop-blur-sm",
        "transition-all duration-300 hover:scale-[1.02]",
        isUser 
          ? "bg-gradient-to-br from-primary to-accent text-primary-foreground ml-auto"
          : "bg-card/80 text-card-foreground border border-border/50"
      )}>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  );
};
