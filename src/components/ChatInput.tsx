import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export const ChatInput = ({ onSend, disabled }: ChatInputProps) => {
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    if (input.trim() && !disabled) {
      onSend(input.trim());
      setInput("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="w-full bg-card/80 backdrop-blur-md rounded-2xl p-4 border border-border/50 shadow-lg">
      <div className="flex gap-3">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask the agent to perform a task..."
          className="min-h-[60px] resize-none bg-background/50 border-border/50 focus:border-primary transition-all duration-300"
          disabled={disabled}
        />
        <Button
          onClick={handleSubmit}
          disabled={disabled || !input.trim()}
          className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-all duration-300 px-6 shadow-glow"
        >
          <Send className="w-5 h-5" />
        </Button>
      </div>
    </div>
  );
};
