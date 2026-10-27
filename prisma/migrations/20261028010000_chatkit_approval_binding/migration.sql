ALTER TABLE paused_runs ADD COLUMN chatkit_thread_id TEXT;
ALTER TABLE paused_runs ADD CONSTRAINT paused_runs_chatkit_thread_id_fkey
  FOREIGN KEY (chatkit_thread_id) REFERENCES chatkit_threads(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX paused_runs_chatkit_thread_id_status_idx ON paused_runs(chatkit_thread_id, status);

-- The original ChatKit implementation used the thread as its trace group.
UPDATE paused_runs p SET chatkit_thread_id = t.id
FROM chatkit_threads t
WHERE p.run_options->>'workflowName' = 'chatkit-turn'
  AND p.run_options->>'groupId' = t.id AND p.owner_id = t.user_id;

-- Only the newest pending card belongs to the current checkpoint; older cards stay invalid.
WITH latest_card AS (
  SELECT DISTINCT ON (p.id) i.thread_id, i.id AS old_id, p.version,
    'msg_approval_' || replace(p.id::text, '-', '') || '_' || p.version AS new_id
  FROM paused_runs p JOIN chatkit_items i ON i.thread_id = p.chatkit_thread_id
  WHERE p.status = 'waiting' AND i.data->>'type' = 'widget'
    AND i.data #>> '{widget,confirm,action,payload,runId}' = p.id::text
  ORDER BY p.id, i.seq DESC
)
UPDATE chatkit_items i SET id = c.new_id,
  data = jsonb_set(jsonb_set(jsonb_set(i.data, '{id}', to_jsonb(c.new_id)),
    '{widget,confirm,action,payload,version}', to_jsonb(c.version)),
    '{widget,cancel,action,payload,version}', to_jsonb(c.version))
FROM latest_card c WHERE i.thread_id = c.thread_id AND i.id = c.old_id;

CREATE TYPE "ConversationType" AS ENUM ('chat', 'chatkit');
ALTER TABLE agent_runs ADD COLUMN conversation_type "ConversationType" NOT NULL DEFAULT 'chat';
CREATE INDEX agent_runs_conversation_type_chat_id_created_at_idx
  ON agent_runs(conversation_type, chat_id, created_at);
