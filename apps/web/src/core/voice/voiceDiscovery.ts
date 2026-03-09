export interface VoiceDiscoveryResult {
    apiBaseUrl: string;
    livekitWsUrl: string;
    features: {
        participants: boolean;
        audioState: boolean;
    };
}

async function doFetchVoiceDiscovery(homeserverUrl: string): Promise<VoiceDiscoveryResult | null> {
    const base = homeserverUrl.replace(/\/$/, "");

    // Try /.well-known/matrix/client for a custom discovery URL
    let discoveryUrl = `${base}/voice/discovery`;
    try {
        const wellKnownRes = await fetch(`${base}/.well-known/matrix/client`, {
            signal: AbortSignal.timeout(5000),
        });
        if (wellKnownRes.ok) {
            const wellKnown = (await wellKnownRes.json()) as Record<string, unknown>;
            const heorotVoice = wellKnown["org.heorot.voice"] as { discovery_url?: string } | undefined;
            const customUrl = heorotVoice?.discovery_url;
            if (typeof customUrl === "string" && customUrl.startsWith("https://")) {
                discoveryUrl = customUrl;
            }
        }
    } catch {
        // ignore, fall back to default
    }

    try {
        const res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const body = (await res.json()) as {
            ok?: boolean;
            apiBaseUrl?: string;
            livekitWsUrl?: string;
            features?: { participants?: boolean; audioState?: boolean };
        };
        if (!body.ok || typeof body.apiBaseUrl !== "string" || typeof body.livekitWsUrl !== "string") {
            return null;
        }
        return {
            apiBaseUrl: body.apiBaseUrl.replace(/\/$/, ""),
            livekitWsUrl: body.livekitWsUrl,
            features: {
                participants: body.features?.participants ?? false,
                audioState: body.features?.audioState ?? false,
            },
        };
    } catch {
        return null;
    }
}

let _discovery: VoiceDiscoveryResult | null = null;
let _pending: Promise<VoiceDiscoveryResult | null> | null = null;

export async function initVoiceDiscovery(homeserverUrl: string): Promise<void> {
    if (_discovery) return;
    if (_pending) {
        await _pending;
        return;
    }
    _pending = doFetchVoiceDiscovery(homeserverUrl);
    _discovery = await _pending;
    _pending = null;
}

export function getVoiceDiscovery(): VoiceDiscoveryResult | null {
    return _discovery;
}

export function clearVoiceDiscovery(): void {
    _discovery = null;
    _pending = null;
}
