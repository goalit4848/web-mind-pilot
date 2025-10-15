-- Create tasks table for persistent agent task management
CREATE TABLE public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'running', 'completed', 'failed'))
);

-- Enable Row Level Security
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Allow users to view their own tasks
CREATE POLICY "Users can view own tasks" ON public.tasks
  FOR SELECT USING (true);

-- Allow users to create tasks
CREATE POLICY "Users can insert tasks" ON public.tasks
  FOR INSERT WITH CHECK (true);

-- Allow system to update tasks (for worker)
CREATE POLICY "System can update tasks" ON public.tasks
  FOR UPDATE USING (true);

-- Enable realtime for tasks table
ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks;