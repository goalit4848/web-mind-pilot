-- Add agent_thought column to tasks table for real-time status updates
ALTER TABLE tasks ADD COLUMN agent_thought TEXT;