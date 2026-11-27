import type {ProjectMetadata} from './contracts.js'
import {tool} from './extensions.js'

/** 一组由协调节点签发，且只在该批 L2 任务内有效的成员。 */
export interface Room {
  id: string
  coordinatorNode: string
  members: {nodeId: string; agentId: string}[]
  grant: string
}

/** 源节点签名随消息发到执行节点，再由执行节点交回调度队列。 */
export interface PeerMessage {
  messageId: string
  room: Room
  senderAgentId: string
  targetAgentId: string
  text: string
  proof: string
}

export interface PeerInboxMessage extends PeerMessage {
  sourceNodeId: string
  targetNodeId: string
}

/** 执行和授权留在编排器，Mesh 提供设备连接及身份凭据。 */
export interface MeshPort {
  nodeId: string
  wireNodeId?: string
  nodeIds: readonly string[]
  queryProjects(nodeId: string, owner: string, search?: string, signal?: AbortSignal): Promise<ProjectMetadata[]>
  peerSend(target: {nodeId: string; agentId: string}, message: Omit<PeerMessage, 'targetAgentId'>,
    signal?: AbortSignal): Promise<void>
  submitPeerInbox(coordinatorNode: string, message: PeerInboxMessage, signal?: AbortSignal): Promise<void>
  sign(data: string): string
  verify(nodeId: string, data: string, signature: string): boolean
}

/** 旧的纯本机 Room 继续使用签发时的本机逻辑 ID。 */
export function roomLocalNode(mesh: MeshPort, room: Pick<Room, 'coordinatorNode'>): string {
  return room.coordinatorNode === mesh.nodeId ? mesh.nodeId : mesh.wireNodeId ?? mesh.nodeId
}

const string = {type: 'string'}

export const batchSpawn = tool('agent_spawn',
  '并行派发一批 L2 项目智能体。使用 query_projects 返回的 nodeId 和 projectId。仅在需要成员直接交换消息时开启 room。',
  {agents: {type: 'array', minItems: 1, maxItems: 12, items: {
    type: 'object', properties: {
      nodeId: string, projectId: string, modelId: string, title: string, instruction: string,
      permissions: {type: 'array', items: string},
    },
    required: ['nodeId', 'projectId', 'modelId', 'title', 'instruction'], additionalProperties: false,
  }}, room: {type: 'boolean'}, max_depth: {type: 'integer', minimum: 1, maximum: 2}}, ['agents'])

export const peerSend = tool('peer_send', '将消息发送给同一个 Room 中当前可用的 L2 成员。',
  {target_node: string, target_agent_id: string, text: string})

export function roomPayload(room: Omit<Room, 'grant'>): string {
  return JSON.stringify(['dsh-prism-room/1', room.id, room.coordinatorNode, room.members.map(({nodeId, agentId}) => [nodeId, agentId])])
}

export function peerPayload(message: Omit<PeerMessage, 'proof'>, targetNodeId: string): string {
  return JSON.stringify(['dsh-prism-peer/1', message.messageId, message.room.id, message.senderAgentId,
    message.targetAgentId, targetNodeId, message.text])
}

export function hasMember(room: Room, nodeId: string, agentId: string): boolean {
  return room.members.some(member => member.nodeId === nodeId && member.agentId === agentId)
}
