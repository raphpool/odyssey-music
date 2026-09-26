import type { IncomingMessage, ServerResponse } from "node:http";
import type { MobileCatalog } from "./catalog.js";
import { createMobileHttpHandler } from "./http.js";

interface MobileRouterDependencies {
	catalog: MobileCatalog;
}

export interface MobileRouterRequest {
	req: IncomingMessage;
	res: ServerResponse;
	url: URL;
}

export interface MobileRouter {
	handle(request: MobileRouterRequest): Promise<boolean>;
}

// Keep the mobile surface injectable so its HTTP contract can be exercised without
// booting the legacy server, whose startup loads cache and provider configuration.
export function createMobileRouter(dependencies: MobileRouterDependencies): MobileRouter {
	const handleHttp = createMobileHttpHandler(dependencies);
	return { handle: handleHttp };
}
