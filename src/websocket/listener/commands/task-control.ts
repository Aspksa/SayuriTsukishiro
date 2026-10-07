import type WebSocket from "ws";
import type { LaunchSubagentCommand } from "@/types/subagent-protocol";
import type { TaskControlCommand } from "@/types/task-control-protocol";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { isSayuriControlCommand } from "../sayuri-control-protocol-inbound";
import { handleMonitorStopCommand } from "./monitors";
import { handleLaunchSubagentCommand } from "./subagents";
import type {
  GetOrCreateScopedRuntime,
  RunDetachedListenerTask,
  SafeSocketSend,
} from "./types";

export async function handleTaskControlCommand(
  command: LaunchSubagentCommand | TaskControlCommand,
  context: {
    runtime: ListenerRuntime;
    socket: WebSocket;
    connectionId?: string;
    getOrCreateScopedRuntime: GetOrCreateScopedRuntime;
    runDetachedListenerTask: RunDetachedListenerTask;
    safeSocketSend: SafeSocketSend;
  },
): Promise<void> {
  const {
    runtime,
    socket,
    connectionId,
    getOrCreateScopedRuntime,
    runDetachedListenerTask,
    safeSocketSend,
  } = context;
  const execute = async () => {
    if (isSayuriControlCommand(command)) {
      const { handleSayuriControlCommand } = await import("./sayuri-control");
      await handleSayuriControlCommand(command, {
        runtime,
        socket,
        connectionId,
        safeSocketSend,
      });
      return;
    }
    const response =
      command.type === "monitor_stop"
        ? await handleMonitorStopCommand(command, runtime)
        : await handleLaunchSubagentCommand(
            command,
            getOrCreateScopedRuntime(
              runtime,
              command.runtime.agent_id,
              command.runtime.conversation_id,
            ),
            connectionId,
          );
    safeSocketSend(socket, response, response.type, command.type);
  };
  if (command.type === "launch_subagent") {
    runDetachedListenerTask(command.type, execute);
  } else {
    await execute();
  }
}
