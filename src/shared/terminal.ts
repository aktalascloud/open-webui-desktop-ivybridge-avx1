export type ServiceId = 'server' | 'llamacpp' | 'open-terminal'
export type ServiceStatus = 'starting' | 'started' | 'stopping' | 'stopped' | 'failed'
export interface ServiceInfo {
  runId: number
  status: ServiceStatus
  pid: number | null
  url: string | null
  external?: boolean
  reachable: boolean
  error: string | null
}
export type TerminalOutput =
  | { type: 'output'; data: string; sequence: number }
  | { type: 'reset'; runId: number }
