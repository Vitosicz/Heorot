import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
    AudioPresets,
    ConnectionState,
    Room,
    RoomEvent,
    Track,
    VideoPresets,
    type LocalParticipant,
    type Participant,
    type RemoteParticipant,
    type RemoteTrack,
    type RemoteTrackPublication,
} from "livekit-client";
import type { MatrixClient, Room as MatrixRoom } from "matrix-js-sdk/src/matrix";

import { Avatar } from "../Avatar";
import micMutedIcon from "../icons/mic-02.svg";
import volumeMutedIcon from "../icons/volume-mute-02.svg";

import { fetchLiveKitToken, updateVoiceParticipantState } from "../../adapters/voiceAdapter";
import {
    playVoiceJoinSound,
    playVoiceLeaveSound,
    playParticipantJoinSound,
    playParticipantLeaveSound,
    playScreenShareStartSound,
    playScreenShareStopSound,
} from "../../notifications/sound";
import { useMatrix } from "../../providers/MatrixProvider";
import type { AudioSettings } from "../../settings/user/settingsStore";
import { RoomDialog } from "../rooms/RoomDialog";

export type VoiceSessionStatus = "disconnected" | "joining" | "connected";

export interface VoiceControlState {
    joining: boolean;
    connected: boolean;
    micMuted: boolean;
    audioMuted: boolean;
}

export interface VoiceRoomHandle {
    join: () => Promise<void>;
    leave: () => Promise<void>;
    toggleMute: () => Promise<void>;
    toggleAudioMute: () => Promise<void>;
    toggleCamera: () => Promise<void>;
}

interface VoiceRoomProps {
    client: MatrixClient;
    matrixRoomId: string;
    matrixRoom?: MatrixRoom | null;
    audioSettings: AudioSettings;
    onAudioSettingsChange: (audio: AudioSettings) => void;
    autoJoinNonce?: number;
    onSessionStateChange?: (state: { roomId: string; status: VoiceSessionStatus }) => void;
    onLiveParticipantsChange?: (state: {
        roomId: string;
        participants: Array<{ identity: string; userId?: string; isSpeaking: boolean; isScreenSharing: boolean }>;
    }) => void;
    onControlsStateChange?: (state: VoiceControlState) => void;
}

interface VoiceParticipantState {
    participant: Participant | LocalParticipant;
    identity: string;
    matrixUserId?: string;
    isLocal: boolean;
    isSpeaking: boolean;
    isScreenSharing: boolean;
}

interface DesktopCaptureSource {
    id: string;
    name: string;
}

type VoiceDisconnectReason = "user_left" | "switch_room" | "component_unmount" | "join_failed" | "network_or_server";

const SPEAKING_LEVEL_THRESHOLD = 0.008;
const SPEAKING_POLL_INTERVAL_MS = 120;
const VOICE_JOIN_TOKEN_TIMEOUT_MS = 12_000;
const VOICE_JOIN_CONNECT_TIMEOUT_MS = 15_000;
const VOICE_JOIN_MEDIA_SETUP_TIMEOUT_MS = 12_000;
const VOICE_JOIN_MAX_ATTEMPTS = 3;
const VOICE_JOIN_RETRY_BASE_DELAY_MS = 350;
const VOICE_JOIN_RETRY_MAX_DELAY_MS = 3_500;
const VOICE_JOIN_RETRY_BUDGET_MS = 25_000;
const STREAM_SYSTEM_AUDIO_STORAGE_KEY = "heorot.voice.stream_system_audio.v1";

type ScreenShareQualityProfileId = "720p30" | "1080p30" | "1080p60" | "1440p60";

interface ScreenShareQualityProfile {
    id: ScreenShareQualityProfileId;
    label: string;
    captureResolution: {
        width: number;
        height: number;
        frameRate: number;
        aspectRatio?: number;
    };
    publishEncoding: {
        maxBitrate: number;
        maxFramerate: number;
    };
    contentHint: "detail" | "motion";
}

type MicrophoneCaptureOptions = NonNullable<Parameters<LocalParticipant["setMicrophoneEnabled"]>[1]>;
type MicrophonePublishOptions = NonNullable<Parameters<LocalParticipant["setMicrophoneEnabled"]>[2]>;
type ScreenSharePublishOptions = NonNullable<Parameters<LocalParticipant["setScreenShareEnabled"]>[2]>;

function withFrameRate(
    resolution: { width: number; height: number; frameRate?: number; aspectRatio?: number },
    frameRate: number,
): ScreenShareQualityProfile["captureResolution"] {
    return {
        ...resolution,
        frameRate,
    };
}

const SCREEN_SHARE_QUALITY_PROFILES: ScreenShareQualityProfile[] = [
    {
        id: "720p30",
        label: "720p @ 30 (Low)",
        captureResolution: withFrameRate(VideoPresets.h720.resolution, 30),
        publishEncoding: { maxBitrate: 2_000_000, maxFramerate: 30 },
        contentHint: "detail",
    },
    {
        id: "1080p30",
        label: "1080p @ 30 (Balanced)",
        captureResolution: withFrameRate(VideoPresets.h1080.resolution, 30),
        publishEncoding: { maxBitrate: 5_000_000, maxFramerate: 30 },
        contentHint: "detail",
    },
    {
        id: "1080p60",
        label: "1080p @ 60 (Smooth)",
        captureResolution: withFrameRate(VideoPresets.h1080.resolution, 60),
        publishEncoding: { maxBitrate: 10_000_000, maxFramerate: 60 },
        contentHint: "motion",
    },
    {
        id: "1440p60",
        label: "1440p @ 60 (Ultra)",
        captureResolution: withFrameRate(VideoPresets.h1440.resolution, 60),
        publishEncoding: { maxBitrate: 14_000_000, maxFramerate: 60 },
        contentHint: "motion",
    },
];

const DEFAULT_SCREEN_SHARE_QUALITY_PROFILE_ID: ScreenShareQualityProfileId = "1080p60";

function areParticipantListsEqual(left: VoiceParticipantState[], right: VoiceParticipantState[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (
            left[index].identity !== right[index].identity ||
            left[index].matrixUserId !== right[index].matrixUserId ||
            left[index].isLocal !== right[index].isLocal ||
            left[index].isSpeaking !== right[index].isSpeaking ||
            left[index].isScreenSharing !== right[index].isScreenSharing
        ) {
            return false;
        }
    }
    return true;
}

function formatDeviceLabel(device: MediaDeviceInfo): string {
    return device.label && device.label.trim().length > 0 ? device.label : `${device.kind} (${device.deviceId.slice(0, 6)})`;
}

// NOTE: parseMatrixUserIdFromMetadata / parseMatrixUserIdFromIdentity / resolveParticipantMatrixUserId
// are intentionally duplicated in heorot-voice-relay/src/services/livekit.ts.
// Both sides must parse LiveKit participant metadata the same way - keep them in sync.
function parseMatrixUserIdFromMetadata(metadata: string | undefined): string | undefined {
    if (!metadata || metadata.trim().length === 0) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(metadata) as { matrixUserId?: unknown };
        if (typeof parsed.matrixUserId === "string" && parsed.matrixUserId.trim().length > 0) {
            return parsed.matrixUserId.trim();
        }
    } catch {
        // ignore malformed metadata
    }

    return undefined;
}

function parseMatrixUserIdFromIdentity(identity: string): string | undefined {
    if (!identity.startsWith("@")) {
        return undefined;
    }
    const separatorIndex = identity.indexOf("::");
    const candidate = separatorIndex > 0 ? identity.slice(0, separatorIndex) : identity;
    return candidate.includes(":") ? candidate : undefined;
}

function resolveParticipantMatrixUserId(participant: Participant | LocalParticipant): string | undefined {
    const metadata = (participant as { metadata?: unknown }).metadata;
    const metadataValue = typeof metadata === "string" ? metadata : undefined;
    const fromMetadata = parseMatrixUserIdFromMetadata(metadataValue);
    if (fromMetadata) {
        return fromMetadata;
    }
    return parseMatrixUserIdFromIdentity(participant.identity);
}

function getParticipantDisplayInfo(
    matrixRoom: MatrixRoom | null | undefined,
    identity: string,
    matrixUserId: string | undefined,
    isLocal: boolean,
    ownDisplayName?: string,
): { displayName: string; avatarMxc?: string; userId?: string } {
    const userId = matrixUserId ?? parseMatrixUserIdFromIdentity(identity);
    if (isLocal && ownDisplayName) {
        return { displayName: ownDisplayName, userId };
    }
    if (!userId) {
        return { displayName: identity };
    }
    const member = matrixRoom?.getMember(userId);
    const displayName = member?.rawDisplayName || member?.name || userId;
    const avatarMxc = member?.getMxcAvatarUrl?.() ?? undefined;
    return { displayName, avatarMxc, userId };
}

function isParticipantScreenSharing(participant: Participant | LocalParticipant): boolean {
    const publication = participant.getTrackPublication?.(Track.Source.ScreenShare) as
        | { track?: unknown; isSubscribed?: boolean; isMuted?: boolean; videoTrack?: unknown }
        | undefined;
    if (!publication || publication.isMuted === true) {
        return false;
    }
    return Boolean(publication.track || publication.videoTrack || publication.isSubscribed);
}

function isUnsupportedScreenShareError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    const normalized = `${error.name} ${error.message}`.toLowerCase();
    return normalized.includes("notsupported") || normalized.includes("not supported");
}

function withTimeout<T>(
    task: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
    onTimeout?: () => void,
): Promise<T> {
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const timeoutTask = new Promise<T>((_, reject) => {
        timeoutId = globalThis.setTimeout(() => {
            onTimeout?.();
            reject(new Error(timeoutMessage));
        }, timeoutMs);
    });

    return Promise.race([task, timeoutTask]).finally(() => {
        if (timeoutId !== null) {
            globalThis.clearTimeout(timeoutId);
        }
    });
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

function extractJoinErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== "object") {
        return null;
    }
    const candidate = (error as { status?: unknown }).status;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        return null;
    }
    return candidate;
}

function extractJoinRetryAfterMs(error: unknown): number | null {
    if (!error || typeof error !== "object") {
        return null;
    }
    const candidate = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
        return null;
    }
    return Math.round(candidate);
}

function isRecoverableVoiceJoinError(error: unknown): boolean {
    if (isAbortError(error)) {
        return false;
    }

    const status = extractJoinErrorStatus(error);
    if (status === 408 || status === 425 || status === 429) {
        return true;
    }
    if (status !== null && status >= 500) {
        return true;
    }

    if (!(error instanceof Error)) {
        return false;
    }

    if (error instanceof TypeError) {
        return true;
    }
    const normalizedMessage = `${error.name} ${error.message}`.toLowerCase();
    return (
        normalizedMessage.includes("timeout") ||
        normalizedMessage.includes("timed out") ||
        normalizedMessage.includes("network") ||
        normalizedMessage.includes("failed to fetch")
    );
}

function getVoiceJoinRetryDelayMs(error: unknown, attemptNumber: number): number {
    const retryAfterMs = extractJoinRetryAfterMs(error);
    if (retryAfterMs !== null) {
        return Math.min(Math.max(retryAfterMs, 0), VOICE_JOIN_RETRY_MAX_DELAY_MS);
    }

    const safeAttempt = Math.max(1, Math.floor(attemptNumber));
    const exponentialDelayMs = VOICE_JOIN_RETRY_BASE_DELAY_MS * 2 ** (safeAttempt - 1);
    const jitterMs = (safeAttempt * 37) % 120;
    return Math.min(exponentialDelayMs + jitterMs, VOICE_JOIN_RETRY_MAX_DELAY_MS);
}

function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    if (delayMs <= 0) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timeoutId = globalThis.setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, delayMs);

        const onAbort = (): void => {
            globalThis.clearTimeout(timeoutId);
            signal.removeEventListener("abort", onAbort);
            reject(new DOMException("Voice join retry was cancelled.", "AbortError"));
        };

        signal.addEventListener("abort", onAbort, { once: true });
    });
}

function isScreenShareQualityProfileId(value: string): value is ScreenShareQualityProfileId {
    return SCREEN_SHARE_QUALITY_PROFILES.some((profile) => profile.id === value);
}

function getScreenShareQualityProfile(profileId: ScreenShareQualityProfileId): ScreenShareQualityProfile {
    return SCREEN_SHARE_QUALITY_PROFILES.find((profile) => profile.id === profileId) ?? SCREEN_SHARE_QUALITY_PROFILES[0];
}

function loadStreamSystemAudioPreference(): boolean {
    if (typeof window === "undefined") {
        return false;
    }
    try {
        return window.localStorage.getItem(STREAM_SYSTEM_AUDIO_STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

function saveStreamSystemAudioPreference(enabled: boolean): void {
    if (typeof window === "undefined") {
        return;
    }
    try {
        window.localStorage.setItem(STREAM_SYSTEM_AUDIO_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
        // ignore persistence failures
    }
}

function buildScreenShareCaptureOptions(audio: boolean, profile: ScreenShareQualityProfile) {
    return {
        audio,
        contentHint: profile.contentHint,
        surfaceSwitching: "include" as const,
        resolution: profile.captureResolution,
    };
}

function buildScreenSharePublishOptions(profile: ScreenShareQualityProfile): ScreenSharePublishOptions {
    const degradationPreference: RTCDegradationPreference =
        profile.contentHint === "motion" ? "maintain-framerate" : "maintain-resolution";
    return {
        screenShareEncoding: profile.publishEncoding,
        degradationPreference,
    };
}

function buildMicrophoneCaptureOptions(settings: AudioSettings): MicrophoneCaptureOptions {
    const capture: MicrophoneCaptureOptions = {
        autoGainControl: settings.autoGainControlEnabled,
        echoCancellation: settings.echoCancellationEnabled,
        noiseSuppression: settings.noiseSuppressionEnabled,
    };
    if (settings.preferredAudioInputId && settings.preferredAudioInputId !== "default") {
        capture.deviceId = { exact: settings.preferredAudioInputId };
    }
    capture.voiceIsolation = settings.voiceIsolationEnabled;
    return capture;
}

function buildMicrophonePublishOptions(settings: AudioSettings): MicrophonePublishOptions {
    return {
        audioPreset: settings.micProfile === "music" ? AudioPresets.music : AudioPresets.speech,
    };
}

function getMicProcessingSignature(settings: AudioSettings): string {
    return [
        settings.autoGainControlEnabled ? "agc1" : "agc0",
        settings.echoCancellationEnabled ? "ec1" : "ec0",
        settings.noiseSuppressionEnabled ? "ns1" : "ns0",
        settings.voiceIsolationEnabled ? "vi1" : "vi0",
        settings.micProfile === "music" ? "music" : "speech",
        settings.preferredAudioInputId || "default",
    ].join("|");
}

export const VoiceRoom = React.forwardRef<VoiceRoomHandle, VoiceRoomProps>(function VoiceRoom(
    {
        client,
        matrixRoomId,
        matrixRoom,
        audioSettings,
        onAudioSettingsChange,
        autoJoinNonce,
        onSessionStateChange,
        onLiveParticipantsChange,
        onControlsStateChange,
    }: VoiceRoomProps,
    ref,
): React.ReactElement {
    const { config } = useMatrix();
    const roomRef = useRef<Room | null>(null);
    const connectedRoomIdRef = useRef<string | null>(null);
    const joinAbortControllerRef = useRef<AbortController | null>(null);
    const joinRequestIdRef = useRef(0);
    const expectedDisconnectReasonByRoomIdRef = useRef<Map<string, VoiceDisconnectReason>>(new Map());
    const lastAutoJoinNonceRef = useRef<number | null>(null);
    const audioSinkRef = useRef<HTMLDivElement | null>(null);
    const screenShareVideoRef = useRef<HTMLVideoElement | null>(null);
    const stageVideoWrapRef = useRef<HTMLDivElement | null>(null);
    const remoteAudioElementsByTrackSidRef = useRef<Map<string, HTMLAudioElement>>(new Map());
    const screenShareAudioTrackSidsRef = useRef<Set<string>>(new Set());
    const screenShareAudioEnabledRef = useRef(false);
    const appliedMicProcessingSignatureRef = useRef<string | null>(null);
    const [screenShareTrackRevision, setScreenShareTrackRevision] = useState(0);
    const [screenShareAudioMuted, setScreenShareAudioMuted] = useState(true);

    const [joining, setJoining] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
    const [micMuted, setMicMuted] = useState(true);
    const [audioMuted, setAudioMuted] = useState(false);
    const [participants, setParticipants] = useState<VoiceParticipantState[]>([]);
    const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
    const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
    const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false);
    const [localAudioPublished, setLocalAudioPublished] = useState(false);
    const [remoteAudioSubscribedCount, setRemoteAudioSubscribedCount] = useState(0);
    const [micTrackSettingsSummary, setMicTrackSettingsSummary] = useState<string | null>(null);
    const [localScreenSharing, setLocalScreenSharing] = useState(false);
    const [activeScreenShareIdentity, setActiveScreenShareIdentity] = useState<string | null>(null);
    const [screenShareQualityProfileId, setScreenShareQualityProfileId] = useState<ScreenShareQualityProfileId>(
        DEFAULT_SCREEN_SHARE_QUALITY_PROFILE_ID,
    );
    const [streamSystemAudioEnabled, setStreamSystemAudioEnabled] = useState<boolean>(() => loadStreamSystemAudioPreference());
    const [stageFullscreen, setStageFullscreen] = useState(false);
    const [desktopCaptureDialogOpen, setDesktopCaptureDialogOpen] = useState(false);
    const [desktopCaptureSources, setDesktopCaptureSources] = useState<DesktopCaptureSource[]>([]);
    const [selectedDesktopCaptureSourceId, setSelectedDesktopCaptureSourceId] = useState<string | null>(null);
    const [submittingDesktopCaptureSource, setSubmittingDesktopCaptureSource] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const desktopCaptureSelectionResolverRef = useRef<((selected: boolean) => void) | null>(null);
    const supportsAudioOutputSelection = useMemo(() => "setSinkId" in HTMLMediaElement.prototype, []);
    const selectedScreenShareQualityProfile = useMemo(
        () => getScreenShareQualityProfile(screenShareQualityProfileId),
        [screenShareQualityProfileId],
    );
    const micProcessingSignature = useMemo(
        () => getMicProcessingSignature(audioSettings),
        [
            audioSettings.autoGainControlEnabled,
            audioSettings.echoCancellationEnabled,
            audioSettings.noiseSuppressionEnabled,
            audioSettings.voiceIsolationEnabled,
            audioSettings.micProfile,
            audioSettings.preferredAudioInputId,
        ],
    );

    const refreshDevices = async (): Promise<void> => {
        try {
            const [inputs, outputs] = await Promise.all([
                Room.getLocalDevices("audioinput"),
                Room.getLocalDevices("audiooutput"),
            ]);
            setAudioInputs(inputs);
            setAudioOutputs(outputs);
        } catch (deviceError) {
            setError(deviceError instanceof Error ? deviceError.message : "Unable to enumerate audio devices.");
        }
    };

    const speakingSidsRef = useRef<Set<string>>(new Set());

    const syncParticipants = useCallback((): void => {
        const room = roomRef.current;
        if (!room) {
            setParticipants((current) => (current.length === 0 ? current : []));
            return;
        }

        if ("activeSpeakers" in room && Array.isArray(room.activeSpeakers)) {
            speakingSidsRef.current = new Set((room.activeSpeakers as Participant[]).map((p) => p.sid));
        }
        const speakingSids = speakingSidsRef.current;
        const isParticipantSpeaking = (participant: Participant | LocalParticipant): boolean => {
            const byEvent = speakingSids.has(participant.sid);
            const byFlag = typeof participant.isSpeaking === "boolean" ? participant.isSpeaking : false;
            const byLevel = typeof participant.audioLevel === "number" && participant.audioLevel > SPEAKING_LEVEL_THRESHOLD;
            return byEvent || byFlag || byLevel;
        };
        const next: VoiceParticipantState[] = [];

        if (room.localParticipant.identity) {
            next.push({
                participant: room.localParticipant,
                identity: room.localParticipant.identity,
                matrixUserId: resolveParticipantMatrixUserId(room.localParticipant),
                isLocal: true,
                isSpeaking: isParticipantSpeaking(room.localParticipant),
                isScreenSharing: isParticipantScreenSharing(room.localParticipant),
            });
        }
        for (const participant of room.remoteParticipants.values()) {
            next.push({
                participant,
                identity: participant.identity,
                matrixUserId: resolveParticipantMatrixUserId(participant),
                isLocal: false,
                isSpeaking: isParticipantSpeaking(participant),
                isScreenSharing: isParticipantScreenSharing(participant),
            });
        }
        setParticipants((current) => (areParticipantListsEqual(current, next) ? current : next));
    }, []);

    useEffect(() => {
        void refreshDevices();
    }, []);

    useEffect(
        () => () => {
            lastAutoJoinNonceRef.current = null;
            joinAbortControllerRef.current?.abort();
            joinAbortControllerRef.current = null;
            joinRequestIdRef.current += 1;
            const room = roomRef.current;
            const roomId = connectedRoomIdRef.current ?? matrixRoomId;
            roomRef.current = null;
            connectedRoomIdRef.current = null;
            clearRemoteAudioElements();
            clearScreenSharePreview();
            if (room) {
                expectedDisconnectReasonByRoomIdRef.current.set(roomId, "component_unmount");
                void room.disconnect();
            }
        },
        [matrixRoomId],
    );

    useEffect(() => {
        const room = roomRef.current;
        if (!room || connectionState !== ConnectionState.Connected) {
            return;
        }

        if (audioSettings.preferredAudioInputId && audioSettings.preferredAudioInputId !== "default") {
            void room.switchActiveDevice("audioinput", audioSettings.preferredAudioInputId).catch(() => undefined);
        }
        if (
            supportsAudioOutputSelection &&
            audioSettings.preferredAudioOutputId &&
            audioSettings.preferredAudioOutputId !== "default"
        ) {
            void room.switchActiveDevice("audiooutput", audioSettings.preferredAudioOutputId).catch(() => undefined);
        }
    }, [audioSettings.preferredAudioInputId, audioSettings.preferredAudioOutputId, connectionState, supportsAudioOutputSelection]);

    useEffect(() => {
        const room = roomRef.current;
        if (!room || connectionState !== ConnectionState.Connected || micMuted) {
            return;
        }
        if (appliedMicProcessingSignatureRef.current === micProcessingSignature) {
            return;
        }

        let disposed = false;
        const applyMicProcessing = async (): Promise<void> => {
            try {
                await room.localParticipant.setMicrophoneEnabled(false);
                if (disposed) {
                    return;
                }
                await room.localParticipant.setMicrophoneEnabled(
                    true,
                    buildMicrophoneCaptureOptions(audioSettings),
                    buildMicrophonePublishOptions(audioSettings),
                );
                if (disposed) {
                    return;
                }
                appliedMicProcessingSignatureRef.current = micProcessingSignature;
                setError(null);
                refreshAudioDiagnostics(room);
            } catch (processingError) {
                if (!disposed) {
                    setError(
                        processingError instanceof Error
                            ? processingError.message
                            : "Unable to apply microphone processing settings.",
                    );
                }
            }
        };

        void applyMicProcessing();
        return () => {
            disposed = true;
        };
    }, [
        connectionState,
        micMuted,
        micProcessingSignature,
        audioSettings.autoGainControlEnabled,
        audioSettings.echoCancellationEnabled,
        audioSettings.noiseSuppressionEnabled,
        audioSettings.voiceIsolationEnabled,
        audioSettings.micProfile,
        audioSettings.preferredAudioInputId,
    ]);

    useEffect(() => {
        if (connectionState !== ConnectionState.Connected) {
            return;
        }
        const intervalId = window.setInterval(() => {
            syncParticipants();
        }, SPEAKING_POLL_INTERVAL_MS);
        return () => {
            window.clearInterval(intervalId);
        };
    }, [connectionState, syncParticipants]);

    const getScreenShareVideoPublicationForIdentity = useCallback(
        (identity: string):
            | {
                  videoTrack?: {
                      attach: (element: HTMLVideoElement) => unknown;
                      detach: (element: HTMLVideoElement) => unknown;
                  };
              }
            | undefined => {
            const room = roomRef.current;
            if (!room) {
                return undefined;
            }

            if (room.localParticipant.identity === identity) {
                return room.localParticipant.getTrackPublication?.(Track.Source.ScreenShare) as
                    | {
                          videoTrack?: {
                              attach: (element: HTMLVideoElement) => unknown;
                              detach: (element: HTMLVideoElement) => unknown;
                          };
                      }
                    | undefined;
            }

            for (const participant of room.remoteParticipants.values()) {
                if (participant.identity !== identity) {
                    continue;
                }
                return participant.getTrackPublication?.(Track.Source.ScreenShare) as
                    | {
                          videoTrack?: {
                              attach: (element: HTMLVideoElement) => unknown;
                              detach: (element: HTMLVideoElement) => unknown;
                          };
                      }
                    | undefined;
            }

            return undefined;
        },
        [],
    );

    const screenShareParticipants = useMemo(
        () => participants.filter((participant) => participant.isScreenSharing),
        [participants],
    );

    const hasScreenShareAudio = useMemo(() => {
        const room = roomRef.current;
        if (!room) return false;
        for (const participant of room.remoteParticipants.values()) {
            for (const publication of participant.trackPublications.values()) {
                if (publication.source === Track.Source.ScreenShareAudio && publication.isSubscribed) return true;
            }
        }
        return false;
    }, [screenShareTrackRevision]);

    useEffect(() => {
        if (screenShareParticipants.length === 0) {
            if (activeScreenShareIdentity !== null) {
                setActiveScreenShareIdentity(null);
            }
            return;
        }
        if (!activeScreenShareIdentity || !screenShareParticipants.some((p) => p.identity === activeScreenShareIdentity)) {
            setActiveScreenShareIdentity(screenShareParticipants[0]?.identity ?? null);
        }
    }, [activeScreenShareIdentity, screenShareParticipants]);

    useEffect(() => {
        const stageVideo = screenShareVideoRef.current;
        if (!stageVideo) {
            return;
        }
        if (!activeScreenShareIdentity || connectionState !== ConnectionState.Connected) {
            stageVideo.srcObject = null;
            return;
        }

        const publication = getScreenShareVideoPublicationForIdentity(activeScreenShareIdentity);
        const videoTrack = publication?.videoTrack;
        if (!videoTrack) {
            stageVideo.srcObject = null;
            return;
        }

        videoTrack.attach(stageVideo);
        stageVideo.autoplay = true;
        stageVideo.playsInline = true;
        stageVideo.muted = audioMuted;
        return () => {
            videoTrack.detach(stageVideo);
            stageVideo.srcObject = null;
        };
    }, [activeScreenShareIdentity, audioMuted, connectionState, getScreenShareVideoPublicationForIdentity, screenShareTrackRevision]);

    useEffect(() => {
        for (const [sid, audioElement] of remoteAudioElementsByTrackSidRef.current.entries()) {
            if (screenShareAudioTrackSidsRef.current.has(sid)) {
                audioElement.muted = audioMuted || screenShareAudioMuted;
            } else {
                audioElement.muted = audioMuted;
            }
        }

        const stageVideo = screenShareVideoRef.current;
        if (stageVideo) {
            stageVideo.muted = audioMuted;
        }
    }, [audioMuted, screenShareAudioMuted]);

    useEffect(() => {
        const handleFullscreenChange = (): void => {
            setStageFullscreen(document.fullscreenElement === stageVideoWrapRef.current);
        };
        document.addEventListener("fullscreenchange", handleFullscreenChange);
        return () => {
            document.removeEventListener("fullscreenchange", handleFullscreenChange);
        };
    }, []);

    useEffect(
        () => () => {
            if (desktopCaptureSelectionResolverRef.current) {
                desktopCaptureSelectionResolverRef.current(false);
                desktopCaptureSelectionResolverRef.current = null;
            }
        },
        [],
    );

    const joinVoice = async (attemptNumber = 1, firstAttemptStartedAtMs = Date.now()): Promise<void> => {
        const normalizedAttemptNumber = Math.max(1, Math.floor(attemptNumber));
        const joinStartedAtMs = firstAttemptStartedAtMs;
        const targetRoomId = matrixRoomId;
        if (!targetRoomId) {
            return;
        }
        if (
            connectionState === ConnectionState.Connected &&
            roomRef.current &&
            connectedRoomIdRef.current === targetRoomId
        ) {
            setJoining(false);
            setError(null);
            onSessionStateChange?.({ roomId: targetRoomId, status: "connected" });
            return;
        }
        joinAbortControllerRef.current?.abort();
        const joinAbortController = new AbortController();
        joinAbortControllerRef.current = joinAbortController;
        const requestId = joinRequestIdRef.current + 1;
        joinRequestIdRef.current = requestId;
        const isCurrentJoinRequest = (): boolean => joinRequestIdRef.current === requestId;
        const ensureCurrentJoinRequest = (): void => {
            if (isCurrentJoinRequest()) {
                return;
            }
            throw new DOMException("Voice join request was cancelled.", "AbortError");
        };
        const runIfCurrentJoin = (callback: () => void): void => {
            if (!isCurrentJoinRequest()) {
                return;
            }
            callback();
        };

        setJoining(true);
        setError(null);
        if (normalizedAttemptNumber === 1) {
            onSessionStateChange?.({ roomId: targetRoomId, status: "joining" });
        }
        let inFlightRoom: Room | null = null;
        try {
            const previousRoom = roomRef.current;
            const previousRoomId = connectedRoomIdRef.current;
            roomRef.current = null;
            connectedRoomIdRef.current = null;
            clearRemoteAudioElements();
            if (previousRoom) {
                if (previousRoomId) {
                    expectedDisconnectReasonByRoomIdRef.current.set(previousRoomId, "switch_room");
                }
                void previousRoom.disconnect().catch(() => undefined);
            }
            ensureCurrentJoinRequest();

            const credentials = await withTimeout(
                fetchLiveKitToken(client, config, targetRoomId, {
                    signal: joinAbortController.signal,
                }),
                VOICE_JOIN_TOKEN_TIMEOUT_MS,
                "Voice token request timed out.",
                () => {
                    joinAbortController.abort();
                },
            );
            ensureCurrentJoinRequest();
            const room = new Room({
                adaptiveStream: true,
                dynacast: true,
                audioCaptureDefaults: buildMicrophoneCaptureOptions(audioSettings),
                publishDefaults: buildMicrophonePublishOptions(audioSettings),
            });
            inFlightRoom = room;

            room
                .on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
                    runIfCurrentJoin(() => {
                        setConnectionState(state);
                        if (state === ConnectionState.Reconnecting) {
                        } else if (state === ConnectionState.Connected) {
                        }
                    });
                })
                .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
                    runIfCurrentJoin(() => {
                        speakingSidsRef.current = new Set(speakers.map((p) => p.sid));
                        syncParticipants();
                    });
                })
                .on(RoomEvent.ParticipantConnected, () => {
                    runIfCurrentJoin(() => {
                        void playParticipantJoinSound().catch(() => undefined);
                        syncParticipants();
                        refreshAudioDiagnostics(room);
                    });
                })
                .on(RoomEvent.ParticipantDisconnected, () => {
                    runIfCurrentJoin(() => {
                        void playParticipantLeaveSound().catch(() => undefined);
                        syncParticipants();
                        refreshAudioDiagnostics(room);
                    });
                })
                .on(RoomEvent.TrackPublished, (publication: RemoteTrackPublication) => {
                    if (!isCurrentJoinRequest()) {
                        return;
                    }
                    if (
                        (publication.kind === Track.Kind.Audio ||
                            publication.source === Track.Source.ScreenShare ||
                            publication.source === Track.Source.ScreenShareAudio) &&
                        !publication.isSubscribed
                    ) {
                        publication.setSubscribed(true);
                    }
                    if (
                        publication.source === Track.Source.ScreenShare ||
                        publication.source === Track.Source.ScreenShareAudio
                    ) {
                        setScreenShareTrackRevision((current) => current + 1);
                        syncParticipants();
                    }
                    if (publication.source === Track.Source.ScreenShare) {
                        void playScreenShareStartSound().catch(() => undefined);
                    }
                    refreshAudioDiagnostics(room);
                })
                .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => {
                    if (!isCurrentJoinRequest()) {
                        return;
                    }
                    attachRemoteAudioTrack(track, publication);
                    if (track.kind === Track.Kind.Audio) {
                    }
                    if (
                        publication.source === Track.Source.ScreenShare ||
                        publication.source === Track.Source.ScreenShareAudio
                    ) {
                        setScreenShareTrackRevision((current) => current + 1);
                        syncParticipants();
                    }
                    if (!room.canPlaybackAudio) {
                        setAudioPlaybackBlocked(true);
                    }
                    refreshAudioDiagnostics(room);
                })
                .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, publication: RemoteTrackPublication) => {
                    if (!isCurrentJoinRequest()) {
                        return;
                    }
                    detachRemoteAudioTrack(track, publication);
                    if (
                        publication.source === Track.Source.ScreenShare ||
                        publication.source === Track.Source.ScreenShareAudio
                    ) {
                        setScreenShareTrackRevision((current) => current + 1);
                        syncParticipants();
                    }
                    if (publication.source === Track.Source.ScreenShare) {
                        void playScreenShareStopSound().catch(() => undefined);
                    }
                    refreshAudioDiagnostics(room);
                })
                .on(RoomEvent.TrackSubscriptionFailed, (trackSid: string, participant: RemoteParticipant) => {
                    runIfCurrentJoin(() => {
                        setError(`Audio subscribe failed for ${participant.identity} (${trackSid}).`);
                    });
                })
                .on(RoomEvent.LocalAudioSilenceDetected, () => {
                    runIfCurrentJoin(() => {
                        setError("Local microphone is publishing silence. Check selected input device and OS mic permissions.");
                    });
                })
                .on(RoomEvent.LocalTrackPublished, (publication: { source?: Track.Source }) => {
                    if (!isCurrentJoinRequest()) {
                        return;
                    }
                    if (
                        publication.source === Track.Source.ScreenShare ||
                        publication.source === Track.Source.ScreenShareAudio
                    ) {
                        setScreenShareTrackRevision((current) => current + 1);
                        syncParticipants();
                    }
                    if (publication.source === Track.Source.ScreenShare) {
                        void playScreenShareStartSound().catch(() => undefined);
                    }
                    refreshAudioDiagnostics(room);
                })
                .on(RoomEvent.LocalTrackUnpublished, (publication: { source?: Track.Source }) => {
                    if (!isCurrentJoinRequest()) {
                        return;
                    }
                    if (
                        publication.source === Track.Source.ScreenShare ||
                        publication.source === Track.Source.ScreenShareAudio
                    ) {
                        setScreenShareTrackRevision((current) => current + 1);
                        syncParticipants();
                    }
                    if (publication.source === Track.Source.ScreenShare) {
                        void playScreenShareStopSound().catch(() => undefined);
                    }
                    refreshAudioDiagnostics(room);
                })
                .on(RoomEvent.Disconnected, () => {
                    if (!isCurrentJoinRequest()) {
                        return;
                    }
                    const reason =
                        expectedDisconnectReasonByRoomIdRef.current.get(targetRoomId) ?? "network_or_server";
                    expectedDisconnectReasonByRoomIdRef.current.delete(targetRoomId);
                    setConnectionState(ConnectionState.Disconnected);
                    setMicMuted(true);
                    setAudioPlaybackBlocked(false);
                    setParticipants([]);
                    setLocalAudioPublished(false);
                    setRemoteAudioSubscribedCount(0);
                    setMicTrackSettingsSummary(null);
                    setLocalScreenSharing(false);
                    setActiveScreenShareIdentity(null);
                    setScreenShareTrackRevision(0);
                    connectedRoomIdRef.current = null;
                    appliedMicProcessingSignatureRef.current = null;
                    clearRemoteAudioElements();
                    clearScreenSharePreview();
                    onSessionStateChange?.({ roomId: targetRoomId, status: "disconnected" });
                })
                .on(RoomEvent.MediaDevicesChanged, () => {
                    if (!isCurrentJoinRequest()) {
                        return;
                    }
                    void refreshDevices();
                })
                .on(RoomEvent.MediaDevicesError, (mediaError: Error) => {
                    runIfCurrentJoin(() => {
                        setError(mediaError.message);
                    });
                })
                .on(RoomEvent.AudioPlaybackStatusChanged, (playing: boolean) => {
                    runIfCurrentJoin(() => {
                        setAudioPlaybackBlocked(!playing);
                    });
                });

            await withTimeout(
                room.connect(credentials.wsUrl, credentials.token),
                VOICE_JOIN_CONNECT_TIMEOUT_MS,
                "Voice connection timed out.",
                () => {
                    expectedDisconnectReasonByRoomIdRef.current.set(targetRoomId, "join_failed");
                    void room.disconnect().catch(() => undefined);
                },
            );
            if (!isCurrentJoinRequest()) {
                void room.disconnect().catch(() => undefined);
                return;
            }
            roomRef.current = room;
            connectedRoomIdRef.current = targetRoomId;

            try {
                await room.startAudio();
                setAudioPlaybackBlocked(false);
            } catch {
                setAudioPlaybackBlocked(!room.canPlaybackAudio);
            }
            attachExistingRemoteAudioTracks(room);
            tryPlayAttachedRemoteAudioElements();
            ensureCurrentJoinRequest();
            if (!isCurrentJoinRequest()) {
                void room.disconnect().catch(() => undefined);
                return;
            }

            if (audioSettings.preferredAudioInputId && audioSettings.preferredAudioInputId !== "default") {
                await room.switchActiveDevice("audioinput", audioSettings.preferredAudioInputId);
            }
            if (
                supportsAudioOutputSelection &&
                audioSettings.preferredAudioOutputId &&
                audioSettings.preferredAudioOutputId !== "default"
            ) {
                await room.switchActiveDevice("audiooutput", audioSettings.preferredAudioOutputId);
            }
            ensureCurrentJoinRequest();
            if (!isCurrentJoinRequest()) {
                void room.disconnect().catch(() => undefined);
                return;
            }

            await withTimeout(
                room.localParticipant.setMicrophoneEnabled(
                    true,
                    buildMicrophoneCaptureOptions(audioSettings),
                    buildMicrophonePublishOptions(audioSettings),
                ),
                VOICE_JOIN_MEDIA_SETUP_TIMEOUT_MS,
                "Microphone setup timed out.",
            );
            ensureCurrentJoinRequest();
            if (!isCurrentJoinRequest()) {
                void room.disconnect().catch(() => undefined);
                return;
            }
            appliedMicProcessingSignatureRef.current = micProcessingSignature;
            setMicMuted(false);
            syncParticipants();
            refreshAudioDiagnostics(room);
            void playVoiceJoinSound().catch(() => undefined);
            onSessionStateChange?.({ roomId: targetRoomId, status: "connected" });
        } catch (joinError) {
            if (inFlightRoom) {
                void inFlightRoom.disconnect().catch(() => undefined);
                inFlightRoom = null;
            }
            if (!isCurrentJoinRequest()) {
                return;
            }
            const elapsedMs = Date.now() - joinStartedAtMs;
            const withinRetryBudget = elapsedMs < VOICE_JOIN_RETRY_BUDGET_MS;
            const shouldRetry =
                normalizedAttemptNumber < VOICE_JOIN_MAX_ATTEMPTS &&
                withinRetryBudget &&
                isRecoverableVoiceJoinError(joinError);
            if (shouldRetry) {
                const retryDelayMs = Math.min(
                    getVoiceJoinRetryDelayMs(joinError, normalizedAttemptNumber),
                    Math.max(0, VOICE_JOIN_RETRY_BUDGET_MS - elapsedMs),
                );
                setError(
                    `Voice connection failed. Retrying (${normalizedAttemptNumber + 1}/${VOICE_JOIN_MAX_ATTEMPTS})...`,
                );
                expectedDisconnectReasonByRoomIdRef.current.set(targetRoomId, "join_failed");
                roomRef.current?.disconnect();
                roomRef.current = null;
                connectedRoomIdRef.current = null;
                setConnectionState(ConnectionState.Disconnected);
                setLocalAudioPublished(false);
                setRemoteAudioSubscribedCount(0);
                setMicTrackSettingsSummary(null);
                setLocalScreenSharing(false);
                setActiveScreenShareIdentity(null);
                setScreenShareTrackRevision(0);
                appliedMicProcessingSignatureRef.current = null;
                clearRemoteAudioElements();
                clearScreenSharePreview();

                try {
                    await waitForAbortableDelay(retryDelayMs, joinAbortController.signal);
                } catch {
                    return;
                }
                if (!isCurrentJoinRequest()) {
                    return;
                }
                return joinVoice(normalizedAttemptNumber + 1, joinStartedAtMs);
            }
            const message = joinError instanceof Error ? joinError.message : "Unable to join voice room.";
            setError(message);
            expectedDisconnectReasonByRoomIdRef.current.set(targetRoomId, "join_failed");
            roomRef.current?.disconnect();
            roomRef.current = null;
            connectedRoomIdRef.current = null;
            setConnectionState(ConnectionState.Disconnected);
            setLocalAudioPublished(false);
            setRemoteAudioSubscribedCount(0);
            setMicTrackSettingsSummary(null);
            setLocalScreenSharing(false);
            setActiveScreenShareIdentity(null);
            setScreenShareTrackRevision(0);
            appliedMicProcessingSignatureRef.current = null;
            clearRemoteAudioElements();
            clearScreenSharePreview();
            onSessionStateChange?.({ roomId: targetRoomId, status: "disconnected" });
        } finally {
            if (isCurrentJoinRequest()) {
                setJoining(false);
            }
            if (joinRequestIdRef.current === requestId && joinAbortControllerRef.current === joinAbortController) {
                joinAbortControllerRef.current = null;
            }
        }
    };

    const clearRemoteAudioElements = (): void => {
        for (const audioElement of remoteAudioElementsByTrackSidRef.current.values()) {
            audioElement.srcObject = null;
            audioElement.remove();
        }
        remoteAudioElementsByTrackSidRef.current.clear();
        screenShareAudioTrackSidsRef.current.clear();
        screenShareAudioEnabledRef.current = false;
        setScreenShareAudioMuted(true);

        const sink = audioSinkRef.current;
        if (sink) {
            sink.replaceChildren();
        }
    };

    const tryPlayAttachedRemoteAudioElements = (): void => {
        for (const audioElement of remoteAudioElementsByTrackSidRef.current.values()) {
            void Promise.resolve()
                .then(() => audioElement.play())
                .catch(() => {
                    setAudioPlaybackBlocked(true);
                });
        }
    };

    const clearScreenSharePreview = (): void => {
        const stageVideo = screenShareVideoRef.current;
        if (!stageVideo) {
            return;
        }
        stageVideo.pause();
        stageVideo.srcObject = null;
    };

    const refreshAudioDiagnostics = (room: Room): void => {
        let remoteSubscribed = 0;
        for (const participant of room.remoteParticipants.values()) {
            for (const publication of participant.trackPublications.values()) {
                if (publication.kind === Track.Kind.Audio && publication.isSubscribed) {
                    remoteSubscribed += 1;
                }
            }
        }

        let localPublished = false;
        let localSharing = false;
        for (const publication of room.localParticipant.trackPublications.values()) {
            if (publication.kind === Track.Kind.Audio && publication.track) {
                localPublished = true;
            }
            if (publication.source === Track.Source.ScreenShare && publication.track) {
                localSharing = true;
            }
        }

        const micPublication = room.localParticipant.getTrackPublication?.(Track.Source.Microphone) as
            | { track?: { mediaStreamTrack?: MediaStreamTrack } }
            | undefined;
        const micTrackSettings = micPublication?.track?.mediaStreamTrack?.getSettings?.();
        const voiceIsolation =
            micTrackSettings && "voiceIsolation" in micTrackSettings
                ? (micTrackSettings as MediaTrackSettings & { voiceIsolation?: boolean }).voiceIsolation
                : undefined;
        const micSummaryParts: string[] = [];
        if (micTrackSettings) {
            micSummaryParts.push(
                `EC:${micTrackSettings.echoCancellation === true ? "on" : micTrackSettings.echoCancellation === false ? "off" : "n/a"}`,
            );
            micSummaryParts.push(
                `NS:${micTrackSettings.noiseSuppression === true ? "on" : micTrackSettings.noiseSuppression === false ? "off" : "n/a"}`,
            );
            micSummaryParts.push(
                `AGC:${micTrackSettings.autoGainControl === true ? "on" : micTrackSettings.autoGainControl === false ? "off" : "n/a"}`,
            );
            micSummaryParts.push(`VI:${voiceIsolation === true ? "on" : voiceIsolation === false ? "off" : "n/a"}`);
        }

        setRemoteAudioSubscribedCount(remoteSubscribed);
        setLocalAudioPublished(localPublished);
        setLocalScreenSharing(localSharing);
        setMicTrackSettingsSummary(micSummaryParts.length > 0 ? micSummaryParts.join(" | ") : null);
    };

    const attachRemoteAudioTrack = (track: RemoteTrack, publication: RemoteTrackPublication): void => {
        if (track.kind !== Track.Kind.Audio) {
            return;
        }

        const isScreenShareAudio = publication.source === Track.Source.ScreenShareAudio;
        const trackSid = publication.trackSid || track.sid;

        if (isScreenShareAudio) {
            if (trackSid) screenShareAudioTrackSidsRef.current.add(trackSid);
            if (!screenShareAudioEnabledRef.current) return;
        }

        if (!trackSid || remoteAudioElementsByTrackSidRef.current.has(trackSid)) {
            return;
        }

        const element = track.attach();
        if (!(element instanceof HTMLAudioElement)) {
            element.remove();
            return;
        }

        element.autoplay = true;
        element.setAttribute("playsinline", "true");
        element.muted = audioMuted || (isScreenShareAudio && screenShareAudioMuted);
        element.volume = 1;
        element.dataset.lkTrackSid = trackSid;
        audioSinkRef.current?.appendChild(element);
        remoteAudioElementsByTrackSidRef.current.set(trackSid, element);

        void Promise.resolve()
            .then(() => element.play())
            .catch(() => {
                setAudioPlaybackBlocked(true);
            });
    };

    const detachRemoteAudioTrack = (track: RemoteTrack, publication: RemoteTrackPublication): void => {
        if (track.kind !== Track.Kind.Audio) {
            return;
        }

        const trackSid = publication.trackSid || track.sid;
        if (trackSid) {
            const attachedElement = remoteAudioElementsByTrackSidRef.current.get(trackSid);
            if (attachedElement) {
                track.detach(attachedElement);
                attachedElement.remove();
                remoteAudioElementsByTrackSidRef.current.delete(trackSid);
            }
            screenShareAudioTrackSidsRef.current.delete(trackSid);
            if (screenShareAudioTrackSidsRef.current.size === 0) {
                screenShareAudioEnabledRef.current = false;
                setScreenShareAudioMuted(true);
            }
            return;
        }

        for (const element of track.detach()) {
            element.remove();
        }
    };

    const toggleScreenShareAudio = (): void => {
        if (!screenShareAudioEnabledRef.current) {
            screenShareAudioEnabledRef.current = true;
            const room = roomRef.current;
            if (room) {
                for (const participant of room.remoteParticipants.values()) {
                    for (const publication of participant.trackPublications.values()) {
                        if (publication.source === Track.Source.ScreenShareAudio && publication.track) {
                            attachRemoteAudioTrack(
                                publication.track as RemoteTrack,
                                publication as RemoteTrackPublication,
                            );
                        }
                    }
                }
            }
            setScreenShareAudioMuted(false);
        } else {
            setScreenShareAudioMuted((prev) => !prev);
        }
    };

    const attachExistingRemoteAudioTracks = (room: Room): void => {
        let hasScreenSharePublication = false;
        for (const participant of room.remoteParticipants.values()) {
            for (const publication of participant.trackPublications.values()) {
                if (
                    (publication.kind === Track.Kind.Audio ||
                        publication.source === Track.Source.ScreenShare ||
                        publication.source === Track.Source.ScreenShareAudio) &&
                    !publication.isSubscribed
                ) {
                    publication.setSubscribed(true);
                }
                if (
                    publication.source === Track.Source.ScreenShare ||
                    publication.source === Track.Source.ScreenShareAudio
                ) {
                    hasScreenSharePublication = true;
                }
                if (!publication.track) {
                    continue;
                }
                attachRemoteAudioTrack(publication.track, publication);
            }
        }
        if (hasScreenSharePublication) {
            setScreenShareTrackRevision((current) => current + 1);
        }
    };

    const leaveVoice = async (): Promise<void> => {
        joinAbortControllerRef.current?.abort();
        joinAbortControllerRef.current = null;
        joinRequestIdRef.current += 1;
        const currentRoomId = connectedRoomIdRef.current ?? matrixRoomId;
        void updateVoiceParticipantState(client, config, {
            matrixRoomId: currentRoomId,
            audioMuted: false,
        }).catch(() => undefined);
        const room = roomRef.current;
        roomRef.current = null;
        connectedRoomIdRef.current = null;
        setJoining(false);
        void playVoiceLeaveSound().catch(() => undefined);
        if (room) {
            expectedDisconnectReasonByRoomIdRef.current.set(currentRoomId, "user_left");
            await room.disconnect();
        } else {
        }
        clearRemoteAudioElements();
        clearScreenSharePreview();
        setConnectionState(ConnectionState.Disconnected);
        setParticipants([]);
        setMicMuted(true);
        setAudioPlaybackBlocked(false);
        setLocalAudioPublished(false);
        setRemoteAudioSubscribedCount(0);
        setMicTrackSettingsSummary(null);
        setLocalScreenSharing(false);
        setActiveScreenShareIdentity(null);
        setScreenShareTrackRevision(0);
        appliedMicProcessingSignatureRef.current = null;
        onSessionStateChange?.({ roomId: currentRoomId, status: "disconnected" });
    };

    const toggleMute = async (): Promise<void> => {
        const room = roomRef.current;
        if (!room) {
            return;
        }
        const nextMuted = !micMuted;
        if (nextMuted) {
            await room.localParticipant.setMicrophoneEnabled(false);
        } else {
            await room.localParticipant.setMicrophoneEnabled(
                true,
                buildMicrophoneCaptureOptions(audioSettings),
                buildMicrophonePublishOptions(audioSettings),
            );
            appliedMicProcessingSignatureRef.current = micProcessingSignature;
        }
        setMicMuted(nextMuted);
        refreshAudioDiagnostics(room);
    };

    const toggleAudioMute = async (): Promise<void> => {
        const nextAudioMuted = !audioMuted;
        setAudioMuted(nextAudioMuted);
        const currentRoomId = connectedRoomIdRef.current ?? matrixRoomId;
        void updateVoiceParticipantState(client, config, {
            matrixRoomId: currentRoomId,
            audioMuted: nextAudioMuted,
        }).catch(() => undefined);
    };

    const closeDesktopCaptureDialog = (selected: boolean): void => {
        setDesktopCaptureDialogOpen(false);
        setSubmittingDesktopCaptureSource(false);
        const resolver = desktopCaptureSelectionResolverRef.current;
        desktopCaptureSelectionResolverRef.current = null;
        resolver?.(selected);
    };

    const openDesktopCaptureSourceDialog = (sources: DesktopCaptureSource[]): Promise<boolean> => {
        if (desktopCaptureSelectionResolverRef.current) {
            desktopCaptureSelectionResolverRef.current(false);
            desktopCaptureSelectionResolverRef.current = null;
        }
        setDesktopCaptureSources(sources);
        setSelectedDesktopCaptureSourceId(sources[0]?.id ?? null);
        setDesktopCaptureDialogOpen(true);
        return new Promise((resolve) => {
            desktopCaptureSelectionResolverRef.current = resolve;
        });
    };

    const confirmDesktopCaptureSourceSelection = async (): Promise<void> => {
        const bridge = window.heorotDesktop;
        if (!selectedDesktopCaptureSourceId || !bridge?.setPreferredDisplayMediaSource) {
            closeDesktopCaptureDialog(false);
            return;
        }
        setSubmittingDesktopCaptureSource(true);
        try {
            await bridge.setPreferredDisplayMediaSource(selectedDesktopCaptureSourceId);
            setError(null);
            closeDesktopCaptureDialog(true);
        } catch (selectionError) {
            setSubmittingDesktopCaptureSource(false);
            setError(selectionError instanceof Error ? selectionError.message : "Unable to set stream source.");
        }
    };

    const prepareDesktopCaptureSourceSelection = async (): Promise<boolean> => {
        const bridge = window.heorotDesktop;
        if (!bridge?.getDesktopCapturerSources || !bridge?.setPreferredDisplayMediaSource) {
            return true;
        }

        try {
            const sources = await bridge.getDesktopCapturerSources();
            if (sources.length === 0) {
                setError("No stream source is available.");
                return false;
            }

            if (sources.length === 1) {
                await bridge.setPreferredDisplayMediaSource(sources[0].id);
                return true;
            }

            return await openDesktopCaptureSourceDialog(
                sources.map((source) => ({
                    id: source.id,
                    name: source.name || source.id,
                })),
            );
        } catch (captureSourceError) {
            setError(captureSourceError instanceof Error ? captureSourceError.message : "Unable to prepare stream source selection.");
            return false;
        }
    };

    const toggleScreenShare = async (): Promise<void> => {
        const room = roomRef.current;
        if (!room) {
            return;
        }
        const enableScreenShare = !localScreenSharing;
        try {
            if (enableScreenShare) {
                const hasSourceSelection = await prepareDesktopCaptureSourceSelection();
                if (!hasSourceSelection) {
                    return;
                }
                await room.localParticipant.setScreenShareEnabled(
                    true,
                    buildScreenShareCaptureOptions(streamSystemAudioEnabled, selectedScreenShareQualityProfile),
                    buildScreenSharePublishOptions(selectedScreenShareQualityProfile),
                );
            } else {
                await room.localParticipant.setScreenShareEnabled(false);
            }
            setError(null);
            setScreenShareTrackRevision((current) => current + 1);
            syncParticipants();
            refreshAudioDiagnostics(room);
        } catch (screenShareError) {
            if (enableScreenShare && streamSystemAudioEnabled && isUnsupportedScreenShareError(screenShareError)) {
                try {
                    await room.localParticipant.setScreenShareEnabled(
                        true,
                        buildScreenShareCaptureOptions(false, selectedScreenShareQualityProfile),
                        buildScreenSharePublishOptions(selectedScreenShareQualityProfile),
                    );
                    setError("Screen audio is not supported in this environment. Sharing video without audio.");
                    setScreenShareTrackRevision((current) => current + 1);
                    syncParticipants();
                    refreshAudioDiagnostics(room);
                    return;
                } catch (fallbackError) {
                    setError(fallbackError instanceof Error ? fallbackError.message : "Unable to toggle screen sharing.");
                    return;
                }
            }
            setError(screenShareError instanceof Error ? screenShareError.message : "Unable to toggle screen sharing.");
        }
    };

    const toggleStageFullscreen = async (): Promise<void> => {
        const stageElement = stageVideoWrapRef.current;
        if (!stageElement) {
            return;
        }

        const legacyRequestFullscreen = (stageElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void })
            .webkitRequestFullscreen;
        const legacyExitFullscreen = (document as Document & { webkitExitFullscreen?: () => Promise<void> | void })
            .webkitExitFullscreen;
        const requestFullscreen = stageElement.requestFullscreen?.bind(stageElement) ?? legacyRequestFullscreen?.bind(stageElement);
        const exitFullscreen = document.exitFullscreen?.bind(document) ?? legacyExitFullscreen?.bind(document);

        if (!requestFullscreen || !exitFullscreen) {
            setError("Fullscreen is not supported in this environment.");
            return;
        }

        try {
            if (document.fullscreenElement === stageElement) {
                await exitFullscreen();
            } else {
                await requestFullscreen();
            }
        } catch {
            setError("Unable to toggle fullscreen for screen share.");
        }
    };

    const connected = connectionState === ConnectionState.Connected;

    const ownUserId = client.getUserId() ?? undefined;
    const ownUser = ownUserId ? client.getUser(ownUserId) ?? undefined : undefined;
    const ownDisplayName = ownUser?.displayName ?? ownUserId ?? "You";
    const activeScreenShareParticipant = screenShareParticipants.find(
        (participant) => participant.identity === activeScreenShareIdentity,
    );
    const hasScreenShareStreams = screenShareParticipants.length > 0;
    const micProcessingFlags = useMemo(() => {
        if (!micTrackSettingsSummary) {
            return [];
        }

        return micTrackSettingsSummary
            .split("|")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            .map((entry) => {
                const separatorIndex = entry.indexOf(":");
                if (separatorIndex < 0) {
                    return { key: entry, label: entry, value: "n/a" };
                }
                const label = entry.slice(0, separatorIndex).trim();
                const value = entry.slice(separatorIndex + 1).trim().toLowerCase();
                return {
                    key: label || entry,
                    label: label || entry,
                    value: value || "n/a",
                };
            });
    }, [micTrackSettingsSummary]);
    const activeScreenShareDisplayName = activeScreenShareParticipant
        ? getParticipantDisplayInfo(
              matrixRoom,
              activeScreenShareParticipant.identity,
              activeScreenShareParticipant.matrixUserId,
              activeScreenShareParticipant.isLocal,
              ownDisplayName,
          ).displayName
        : null;

    useEffect(() => {
        if (typeof autoJoinNonce !== "number" || autoJoinNonce <= 0) {
            return;
        }
        if (lastAutoJoinNonceRef.current === autoJoinNonce) {
            return;
        }
        lastAutoJoinNonceRef.current = autoJoinNonce;
        void joinVoice();
    }, [autoJoinNonce]);

    useEffect(() => {
        if (!onLiveParticipantsChange) {
            return;
        }

        onLiveParticipantsChange({
            roomId: connectedRoomIdRef.current ?? matrixRoomId,
            participants: participants.map((participant) => ({
                identity: participant.identity,
                userId: participant.matrixUserId,
                isSpeaking: participant.isSpeaking,
                isScreenSharing: participant.isScreenSharing,
            })),
        });
    }, [matrixRoomId, onLiveParticipantsChange, participants]);

    useEffect(() => {
        if (!onControlsStateChange) {
            return;
        }

        onControlsStateChange({
            joining,
            connected: connectionState === ConnectionState.Connected,
            micMuted,
            audioMuted,
        });
    }, [audioMuted, connectionState, joining, micMuted, onControlsStateChange]);

    useImperativeHandle(ref, () => ({
        join: joinVoice,
        leave: leaveVoice,
        toggleMute,
        toggleAudioMute,
        toggleCamera: () => Promise.resolve(),
    }));

    return (
        <section className="voice-room-panel">
            {/* Main scrollable content */}
            <div className="voice-room-content">
                {/* Screen share stage */}
                {connected && hasScreenShareStreams ? (
                    <div className="voice-room-stage">
                        <div className="voice-room-stage-header">
                            <h3>Screen share</h3>
                            <div className="voice-room-stage-header-actions">
                                <span className="voice-room-stage-status">
                                    {activeScreenShareParticipant
                                        ? `${
                                              activeScreenShareParticipant.isLocal ||
                                              activeScreenShareParticipant.matrixUserId === ownUserId
                                                  ? "You"
                                                  : activeScreenShareDisplayName ?? activeScreenShareParticipant.identity
                                          } is live`
                                        : "No active stream"}
                                </span>
                                {hasScreenShareAudio && (
                                    <button
                                        type="button"
                                        className={`voice-room-stage-audio-button${screenShareAudioMuted ? " is-muted" : ""}`}
                                        onClick={toggleScreenShareAudio}
                                        title={screenShareAudioMuted ? "Enable screen audio" : "Mute screen audio"}
                                        aria-pressed={!screenShareAudioMuted}
                                    >
                                        {screenShareAudioMuted ? (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                                                <line x1="23" y1="9" x2="17" y2="15"/>
                                                <line x1="17" y1="9" x2="23" y2="15"/>
                                            </svg>
                                        ) : (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                                                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                                                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                                            </svg>
                                        )}
                                        {screenShareAudioMuted ? "Enable audio" : "Mute audio"}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="voice-room-stage-fullscreen-button"
                                    onClick={() => void toggleStageFullscreen()}
                                    disabled={!activeScreenShareParticipant}
                                >
                                    {stageFullscreen ? "Exit fullscreen" : "Fullscreen"}
                                </button>
                            </div>
                        </div>
                        <div
                            ref={stageVideoWrapRef}
                            className={`voice-room-stage-video-wrap${stageFullscreen ? " is-fullscreen" : ""}`}
                        >
                            {activeScreenShareParticipant ? (
                                <video ref={screenShareVideoRef} className="voice-room-stage-video" autoPlay playsInline />
                            ) : (
                                <div className="voice-room-stage-empty">Preparing screen share...</div>
                            )}
                        </div>
                        {screenShareParticipants.length > 1 ? (
                            <div className="voice-room-stage-picker">
                                {screenShareParticipants.map((participant) => {
                                    const info = getParticipantDisplayInfo(
                                        matrixRoom,
                                        participant.identity,
                                        participant.matrixUserId,
                                        participant.isLocal,
                                        ownDisplayName,
                                    );
                                    const isActive = participant.identity === activeScreenShareIdentity;
                                    return (
                                        <button
                                            key={`screen-share-${participant.identity}`}
                                            type="button"
                                            className={`voice-room-stage-picker-button${isActive ? " is-active" : ""}`}
                                            onClick={() => setActiveScreenShareIdentity(participant.identity)}
                                        >
                                            {participant.isLocal || participant.matrixUserId === ownUserId
                                                ? "You"
                                                : info.displayName}
                                        </button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {/* Participant tile grid */}
                {connected ? (
                    <ul className="voice-room-participants-list">
                        {participants.map((p) => {
                            const info = getParticipantDisplayInfo(
                                matrixRoom,
                                p.identity,
                                p.matrixUserId,
                                p.isLocal,
                                ownDisplayName,
                            );
                            const isYou = p.isLocal || p.matrixUserId === ownUserId;
                            const avatarSrc = info.avatarMxc
                                ? (client.mxcUrlToHttp(info.avatarMxc, 240, 240, "crop") ?? null)
                                : null;
                            return (
                                <li
                                    key={p.identity}
                                    className={`voice-room-participant${p.isSpeaking ? " is-speaking" : ""}${p.isScreenSharing ? " is-sharing" : ""}`}
                                >
                                    <div className="voice-room-participant-avatar-wrap">
                                        <Avatar
                                            className="voice-room-participant-avatar avatar"
                                            name={info.displayName}
                                            src={avatarSrc}
                                            seed={info.userId}
                                            userId={info.userId}
                                        />
                                        <span
                                            className={`voice-room-speaking-indicator${p.isSpeaking ? " is-speaking" : ""}`}
                                            aria-hidden="true"
                                        />
                                    </div>
                                    <span className="voice-room-participant-name">
                                        {isYou ? `${info.displayName} (You)` : info.displayName}
                                    </span>
                                    {p.isScreenSharing ? (
                                        <span className="voice-room-participant-live">LIVE</span>
                                    ) : null}
                                    <span
                                        className={`voice-room-speaking-bars${p.isSpeaking ? " is-speaking" : ""}`}
                                        aria-hidden="true"
                                    >
                                        <span />
                                        <span />
                                        <span />
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                ) : (
                    <div className="voice-room-idle">
                        {joining ? (
                            <p className="voice-room-idle-hint">Connecting...</p>
                        ) : (
                            <p className="voice-room-idle-hint">You are not connected to this voice channel.</p>
                        )}
                    </div>
                )}

                {audioPlaybackBlocked && connected ? (
                    <div className="voice-room-audio-warning">
                        <p>Audio playback is blocked by browser policy.</p>
                        <button
                            type="button"
                            className="settings-button settings-button-secondary"
                            onClick={() => {
                                void roomRef.current
                                    ?.startAudio()
                                    .then(() => {
                                        setAudioPlaybackBlocked(false);
                                        tryPlayAttachedRemoteAudioElements();
                                    })
                                    .catch(() => undefined);
                            }}
                        >
                            Enable audio
                        </button>
                    </div>
                ) : null}

                {error ? <p className="settings-inline-error">{error}</p> : null}
            </div>

            {/* Settings panel (collapsible) */}
            {connected && settingsOpen ? (
                <div className="voice-settings-panel">
                    <div className="voice-room-device-grid">
                        <label className="settings-field">
                            <span>Microphone</span>
                            <select
                                className="room-dialog-input"
                                value={audioSettings.preferredAudioInputId}
                                onChange={(event) =>
                                    onAudioSettingsChange({
                                        ...audioSettings,
                                        preferredAudioInputId: event.target.value,
                                    })
                                }
                            >
                                <option value="default">System default</option>
                                {audioInputs.map((device) => (
                                    <option key={device.deviceId} value={device.deviceId}>
                                        {formatDeviceLabel(device)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="settings-field">
                            <span>Speaker</span>
                            <select
                                className="room-dialog-input"
                                value={audioSettings.preferredAudioOutputId}
                                onChange={(event) =>
                                    onAudioSettingsChange({
                                        ...audioSettings,
                                        preferredAudioOutputId: event.target.value,
                                    })
                                }
                                disabled={!supportsAudioOutputSelection}
                            >
                                <option value="default">System default</option>
                                {audioOutputs.map((device) => (
                                    <option key={device.deviceId} value={device.deviceId}>
                                        {formatDeviceLabel(device)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    {!supportsAudioOutputSelection ? (
                        <p className="settings-inline-note">Speaker output switching is not supported in this browser.</p>
                    ) : null}
                    <label className="settings-field voice-room-stream-profile-field">
                        <span>Stream quality</span>
                        <select
                            className="room-dialog-input"
                            value={screenShareQualityProfileId}
                            onChange={(event) => {
                                const nextValue = event.target.value;
                                if (!isScreenShareQualityProfileId(nextValue)) {
                                    return;
                                }
                                setScreenShareQualityProfileId(nextValue);
                            }}
                        >
                            {SCREEN_SHARE_QUALITY_PROFILES.map((profile) => (
                                <option key={profile.id} value={profile.id}>
                                    {profile.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="voice-room-stream-audio-toggle">
                        <input
                            type="checkbox"
                            checked={streamSystemAudioEnabled}
                            onChange={(event) => {
                                const enabled = event.target.checked;
                                setStreamSystemAudioEnabled(enabled);
                                saveStreamSystemAudioPreference(enabled);
                            }}
                        />
                        <span>Include system audio in stream</span>
                    </label>
                    {!streamSystemAudioEnabled ? (
                        <p className="settings-inline-note">
                            Recommended for voice channels: prevents OS-wide mute behavior and voice bleed into the stream.
                        </p>
                    ) : null}
                    {streamSystemAudioEnabled && typeof window !== "undefined" && window.heorotDesktop?.platform === "win32" ? (
                        <p className="settings-inline-note">
                            Windows may still alter local playback behavior for full-screen audio capture.
                        </p>
                    ) : null}
                    {localScreenSharing ? (
                        <p className="settings-inline-note">Quality changes apply after restarting stream.</p>
                    ) : null}
                    <details className="voice-room-diagnostics">
                        <summary className="voice-room-diagnostics-summary">
                            <span className="voice-room-diagnostics-title">Voice diagnostics</span>
                            <span className={`voice-room-diag-chip ${localAudioPublished ? "is-good" : "is-bad"}`}>
                                Mic {localAudioPublished ? "published" : "missing"}
                            </span>
                            <span className={`voice-room-diag-chip ${remoteAudioSubscribedCount > 0 ? "is-good" : "is-neutral"}`}>
                                Remote subs {remoteAudioSubscribedCount}
                            </span>
                        </summary>
                        <div className="voice-room-diagnostics-body">
                            {micProcessingFlags.length > 0 ? (
                                <div className="voice-room-diag-chip-row">
                                    {micProcessingFlags.map((flag) => (
                                        <span
                                            key={flag.key}
                                            className={`voice-room-diag-chip ${
                                                flag.value === "on" ? "is-good" : flag.value === "off" ? "is-bad" : "is-neutral"
                                            }`}
                                        >
                                            {flag.label}: {flag.value}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <p className="settings-inline-note">No mic processing metadata.</p>
                            )}
                        </div>
                    </details>
                </div>
            ) : null}

            {/* Controls bar */}
            {connected ? (
                <div className="voice-controls-bar">
                    {/* Mute mic */}
                    <button
                        type="button"
                        className={`voice-ctrl-btn${micMuted ? " is-muted" : ""}`}
                        onClick={() => void toggleMute()}
                        title={micMuted ? "Unmute microphone" : "Mute microphone"}
                        aria-pressed={!micMuted}
                    >
                        {micMuted ? (
                            <img src={micMutedIcon} className="voice-ctrl-icon" alt="" aria-hidden="true" />
                        ) : (
                            <svg className="voice-ctrl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
                                    d="M12 2a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4ZM4 11a8 8 0 0 0 16 0M12 19v3m0 0h3m-3 0H9" />
                            </svg>
                        )}
                        <span className="voice-ctrl-label">{micMuted ? "Unmute" : "Mute"}</span>
                    </button>

                    {/* Screen share */}
                    <button
                        type="button"
                        className={`voice-ctrl-btn${localScreenSharing ? " is-active" : ""}`}
                        onClick={() => void toggleScreenShare()}
                        title={localScreenSharing ? "Stop screen share" : "Share screen"}
                        aria-pressed={localScreenSharing}
                    >
                        <svg className="voice-ctrl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            {localScreenSharing ? (
                                <path fill="currentColor"
                                    d="M4 5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H4Zm0 2h16v9H4V7Zm4 11v2H6a1 1 0 1 0 0 2h12a1 1 0 1 0 0-2h-2v-2H8Z" />
                            ) : (
                                <path fill="currentColor"
                                    d="M4 5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h6v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-2v-2h6a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H4Zm0 2h16v9H4V7Zm8.7 2.3a1 1 0 0 0-1.4 1.4l.6.6H8a1 1 0 1 0 0 2h3.9l-.6.6a1 1 0 1 0 1.4 1.4l2.3-2.3a1 1 0 0 0 0-1.4l-2.3-2.3Z" />
                            )}
                        </svg>
                        <span className="voice-ctrl-label">{localScreenSharing ? "Stop" : "Share"}</span>
                    </button>

                    {/* Deafen */}
                    <button
                        type="button"
                        className={`voice-ctrl-btn${audioMuted ? " is-muted" : ""}`}
                        onClick={() => void toggleAudioMute()}
                        title={audioMuted ? "Undeafen" : "Deafen"}
                        aria-pressed={audioMuted}
                    >
                        {audioMuted ? (
                            <img src={volumeMutedIcon} className="voice-ctrl-icon" alt="" aria-hidden="true" />
                        ) : (
                            <svg className="voice-ctrl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
                                    d="M11.553 3.064A.75.75 0 0 1 12 3.75v16.5a.75.75 0 0 1-1.255.555L5.46 16H2.75A1.75 1.75 0 0 1 1 14.25v-4.5C1 8.784 1.784 8 2.75 8H5.46l5.285-4.805a.75.75 0 0 1 .808-.13ZM18.5 12a6.5 6.5 0 0 0-1.905-4.628 1 1 0 0 0-1.395 1.437A4.5 4.5 0 0 1 16.5 12a4.5 4.5 0 0 1-1.3 3.192 1 1 0 1 0 1.395 1.436A6.5 6.5 0 0 0 18.5 12Z" />
                            </svg>
                        )}
                        <span className="voice-ctrl-label">{audioMuted ? "Undeafen" : "Deafen"}</span>
                    </button>

                    {/* Settings */}
                    <button
                        type="button"
                        className={`voice-ctrl-btn${settingsOpen ? " is-active" : ""}`}
                        onClick={() => setSettingsOpen((prev) => !prev)}
                        title="Voice settings"
                        aria-pressed={settingsOpen}
                    >
                        <svg className="voice-ctrl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
                                d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                        <span className="voice-ctrl-label">Settings</span>
                    </button>

                    {/* Leave */}
                    <button
                        type="button"
                        className="voice-ctrl-btn voice-ctrl-leave"
                        onClick={() => void leaveVoice()}
                        title="Leave voice channel"
                    >
                        <svg className="voice-ctrl-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path fill="currentColor"
                                d="M10.68 5.146a1 1 0 0 1 .096 1.412L8.374 9H15.5a6.5 6.5 0 0 1 0 13H12a1 1 0 1 1 0-2h3.5a4.5 4.5 0 0 0 0-9H8.374l2.402 2.442a1 1 0 0 1-1.428 1.402l-4.1-4.167a1 1 0 0 1 .019-1.423l4.1-3.833a1 1 0 0 1 1.313.725Z" />
                        </svg>
                        <span className="voice-ctrl-label">Leave</span>
                    </button>
                </div>
            ) : null}

            <div ref={audioSinkRef} aria-hidden="true" style={{ display: "none" }} />

            <RoomDialog
                open={desktopCaptureDialogOpen}
                title="Choose stream source"
                onClose={() => closeDesktopCaptureDialog(false)}
                footer={
                    <>
                        <button
                            type="button"
                            className="room-dialog-button room-dialog-button-secondary"
                            onClick={() => closeDesktopCaptureDialog(false)}
                            disabled={submittingDesktopCaptureSource}
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="room-dialog-button room-dialog-button-primary"
                            onClick={() => void confirmDesktopCaptureSourceSelection()}
                            disabled={!selectedDesktopCaptureSourceId || submittingDesktopCaptureSource}
                        >
                            {submittingDesktopCaptureSource ? "Starting..." : "Stream this"}
                        </button>
                    </>
                }
            >
                <div className="voice-room-capture-source-list">
                    {desktopCaptureSources.map((source) => {
                        const isSelected = source.id === selectedDesktopCaptureSourceId;
                        return (
                            <button
                                key={source.id}
                                type="button"
                                className={`voice-room-capture-source-item${isSelected ? " is-selected" : ""}`}
                                onClick={() => setSelectedDesktopCaptureSourceId(source.id)}
                            >
                                <span className="voice-room-capture-source-name">{source.name}</span>
                                <span className="voice-room-capture-source-id">{source.id}</span>
                            </button>
                        );
                    })}
                </div>
            </RoomDialog>
        </section>
    );
});

VoiceRoom.displayName = "VoiceRoom";


