export function defineRpc<T extends { name: string }>(contract: T): T {
  return contract;
}
export type PluginRpcContract<_I = unknown, _O = unknown> = { name: string };
export function defineSettings<T>(definition: T): T {
  return definition;
}
