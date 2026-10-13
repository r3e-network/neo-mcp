import { resolveRoute, ToolRoute } from '../registry/tool-registry';

/** The protocol adapter supplies effects; the registry remains description-only. */
export interface PublicToolRuntime<Result> {
  initializeServices(): Promise<void>;
  invoke(route: ToolRoute): Promise<unknown>;
  success(result: unknown): Result;
  failure(error: unknown): Result;
}

/** Resolve first, activate only when required, invoke once, then adapt the result. */
export function createPublicToolDispatcher<Result>(runtime: PublicToolRuntime<Result>) {
  return async (name: string, args?: Record<string, unknown> | null): Promise<Result> => {
    try {
      const route = resolveRoute(name, args ?? {});
      if (route.requiresServices) await runtime.initializeServices();
      return runtime.success(await runtime.invoke(route));
    } catch (error: unknown) {
      return runtime.failure(error);
    }
  };
}
