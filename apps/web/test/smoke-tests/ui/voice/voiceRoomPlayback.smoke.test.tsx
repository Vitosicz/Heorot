import React, { createRef } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioSettings } from "../../../../src/ui/settings/user/settingsStore";

type VoiceRoomComponent = typeof import("../../../../src/ui/components/voice/VoiceRoom").VoiceRoom;
type VoiceRoomHandle = import("../../../../src/ui/components/voice/VoiceRoom").VoiceRoomHandle;

interface FakeTrack {
    kind: string;
    sid: string;
    attach: () => HTMLAudioElement;
    detach: (element?: HTMLAudioElement) => HTMLAudioElement[];
}

interface FakePublication {
    kind: string;
    source: string;
    isSubscribed: boolean;
    trackSid: string;
    track: FakeTrack;
    setSubscribed: ReturnType<typeof vi.fn>;
}

function createAudioSettings(): AudioSettings {
    return {
        preferredAudioInputId: "default",
        preferredAudioOutputId: "default",
        micTestLoopbackEnabled: false,
        autoGainControlEnabled: true,
        echoCancellationEnabled: true,
        noiseSuppressionEnabled: true,
        voiceIsolationEnabled: true,
        micProfile: "speech",
    };
}

function createAudioTrack(trackSid: string): FakeTrack {
    return {
        kind: "audio",
        sid: trackSid,
        attach: () => {
            const element = document.createElement("audio");
            return element;
        },
        detach: (element?: HTMLAudioElement) => (element ? [element] : []),
    };
}

function createAudioPublication(trackSid: string): FakePublication {
    const publication = {
        kind: "audio",
        source: "microphone",
        isSubscribed: false,
        trackSid,
        track: createAudioTrack(trackSid),
        setSubscribed: vi.fn(),
    } as FakePublication;

    publication.setSubscribed = vi.fn((value: boolean) => {
        publication.isSubscribed = value;
    });

    return publication;
}

describe("voice room smoke", () => {
    let container: HTMLDivElement;
    let root: Root;
    let VoiceRoom: VoiceRoomComponent;
    let RoomEvent: Record<string, string>;

    let createdRooms: Array<{ emit: (event: string, ...args: unknown[]) => void }>;
    let seededRemotePublications: Array<{
        participantIdentity: string;
        participantSid: string;
        publication: FakePublication;
    }>;
    let playAttempts: string[];

    beforeEach(async () => {
        vi.resetModules();

        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);

        createdRooms = [];
        seededRemotePublications = [];
        playAttempts = [];

        Object.defineProperty(HTMLMediaElement.prototype, "play", {
            configurable: true,
            value: vi.fn(function play(this: HTMLMediaElement) {
                playAttempts.push(this.dataset.lkTrackSid ?? "unknown");
                return Promise.resolve();
            }),
        });

        vi.doMock("livekit-client", () => {
            const ConnectionState = {
                Disconnected: "disconnected",
                Connecting: "connecting",
                Connected: "connected",
                Reconnecting: "reconnecting",
            };

            const RoomEvent = {
                ConnectionStateChanged: "ConnectionStateChanged",
                ActiveSpeakersChanged: "ActiveSpeakersChanged",
                ParticipantConnected: "ParticipantConnected",
                ParticipantDisconnected: "ParticipantDisconnected",
                TrackPublished: "TrackPublished",
                TrackSubscribed: "TrackSubscribed",
                TrackUnsubscribed: "TrackUnsubscribed",
                TrackSubscriptionFailed: "TrackSubscriptionFailed",
                LocalAudioSilenceDetected: "LocalAudioSilenceDetected",
                LocalTrackPublished: "LocalTrackPublished",
                LocalTrackUnpublished: "LocalTrackUnpublished",
                Disconnected: "Disconnected",
                MediaDevicesChanged: "MediaDevicesChanged",
                MediaDevicesError: "MediaDevicesError",
                AudioPlaybackStatusChanged: "AudioPlaybackStatusChanged",
            };

            const Track = {
                Kind: {
                    Audio: "audio",
                    Video: "video",
                },
                Source: {
                    Microphone: "microphone",
                    ScreenShare: "screen_share",
                    ScreenShareAudio: "screen_share_audio",
                },
            };

            class Room {
                public static async getLocalDevices(): Promise<MediaDeviceInfo[]> {
                    return [];
                }

                public readonly remoteParticipants = new Map<string, any>();
                public readonly localParticipant: any;
                public activeSpeakers: unknown[] = [];
                public canPlaybackAudio = true;
                public state = ConnectionState.Disconnected;

                private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

                public constructor() {
                    this.localParticipant = {
                        identity: "@self:example.org::local",
                        sid: "local-sid",
                        isSpeaking: false,
                        audioLevel: 0,
                        trackPublications: new Map<string, any>(),
                        getTrackPublication: (source: string) => this.localParticipant.trackPublications.get(source),
                        setMicrophoneEnabled: async (enabled: boolean) => {
                            if (!enabled) {
                                this.localParticipant.trackPublications.delete(Track.Source.Microphone);
                                return;
                            }
                            this.localParticipant.trackPublications.set(Track.Source.Microphone, {
                                kind: Track.Kind.Audio,
                                source: Track.Source.Microphone,
                                track: {
                                    mediaStreamTrack: {
                                        getSettings: () => ({
                                            echoCancellation: true,
                                            noiseSuppression: true,
                                            autoGainControl: true,
                                            voiceIsolation: true,
                                        }),
                                    },
                                },
                            });
                        },
                        setScreenShareEnabled: async () => undefined,
                    };

                    for (const seed of seededRemotePublications) {
                        const participant = {
                            identity: seed.participantIdentity,
                            sid: seed.participantSid,
                            isSpeaking: false,
                            audioLevel: 0,
                            trackPublications: new Map<string, FakePublication>([[seed.publication.trackSid, seed.publication]]),
                            getTrackPublication: (source: string) => {
                                for (const publication of participant.trackPublications.values()) {
                                    if (publication.source === source) {
                                        return publication;
                                    }
                                }
                                return undefined;
                            },
                        };
                        this.remoteParticipants.set(seed.participantSid, participant);
                    }

                    createdRooms.push(this);
                }

                public on(event: string, handler: (...args: unknown[]) => void): this {
                    const set = this.handlers.get(event) ?? new Set();
                    set.add(handler);
                    this.handlers.set(event, set);
                    return this;
                }

                public emit(event: string, ...args: unknown[]): void {
                    const handlers = this.handlers.get(event);
                    if (!handlers) {
                        return;
                    }
                    for (const handler of handlers) {
                        handler(...args);
                    }
                }

                public async connect(): Promise<void> {
                    this.state = ConnectionState.Connected;
                    this.emit(RoomEvent.ConnectionStateChanged, ConnectionState.Connected);
                }

                public async startAudio(): Promise<void> {
                    this.canPlaybackAudio = true;
                }

                public async switchActiveDevice(): Promise<void> {
                    return;
                }

                public async disconnect(): Promise<void> {
                    this.state = ConnectionState.Disconnected;
                    this.emit(RoomEvent.Disconnected);
                }
            }

            return {
                Room,
                RoomEvent,
                ConnectionState,
                Track,
                AudioPresets: {
                    speech: "speech",
                    music: "music",
                },
                VideoPresets: {
                    h720: { resolution: { width: 1280, height: 720 } },
                    h1080: { resolution: { width: 1920, height: 1080 } },
                    h1440: { resolution: { width: 2560, height: 1440 } },
                },
            };
        });

        vi.doMock("../../../../src/ui/adapters/voiceAdapter", () => ({
            fetchLiveKitToken: vi.fn(async () => ({
                token: "token",
                wsUrl: "wss://livekit.example/ws",
                livekitRoom: "voice-room",
                expiresAt: "2026-01-01T00:00:00.000Z",
            })),
            updateVoiceParticipantState: vi.fn(async () => undefined),
        }));

        vi.doMock("../../../../src/ui/providers/MatrixProvider", () => ({
            useMatrix: () => ({ config: null }),
        }));

        vi.doMock("../../../../src/ui/notifications/sound", () => ({
            playVoiceJoinSound: vi.fn(async () => undefined),
            playVoiceLeaveSound: vi.fn(async () => undefined),
            playParticipantJoinSound: vi.fn(async () => undefined),
            playParticipantLeaveSound: vi.fn(async () => undefined),
            playScreenShareStartSound: vi.fn(async () => undefined),
            playScreenShareStopSound: vi.fn(async () => undefined),
        }));

        vi.doMock("../../../../src/ui/components/Avatar", () => ({
            Avatar: ({ name }: { name?: string }) => React.createElement("div", { "data-avatar": "1" }, name ?? ""),
        }));

        vi.doMock("../../../../src/ui/components/rooms/RoomDialog", () => ({
            RoomDialog: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children ?? null),
        }));

        ({ VoiceRoom } = await import("../../../../src/ui/components/voice/VoiceRoom"));
        ({ RoomEvent } = await import("livekit-client"));
    });

    afterEach(async () => {
        await act(async () => {
            root.unmount();
        });
        container.remove();
        vi.restoreAllMocks();
    });

    it("subscribes and plays late remote audio tracks after join completes", async () => {
        const initialPublication = createAudioPublication("aud-initial");
        seededRemotePublications.push({
            participantIdentity: "@alice:example.org::device-a",
            participantSid: "remote-a",
            publication: initialPublication,
        });

        const ref = createRef<VoiceRoomHandle>();

        await act(async () => {
            root.render(
                React.createElement(VoiceRoom, {
                    ref,
                    client: {
                        getUserId: () => "@self:example.org",
                        getUser: () => ({ rawDisplayName: "Self" }),
                        mxcUrlToHttp: () => null,
                    },
                    matrixRoomId: "!voice:example.org",
                    matrixRoom: null,
                    audioSettings: createAudioSettings(),
                    onAudioSettingsChange: () => undefined,
                }),
            );
        });

        await act(async () => {
            await ref.current?.join();
        });

        const room = createdRooms[0];
        expect(room).toBeTruthy();
        expect(initialPublication.setSubscribed).toHaveBeenCalledWith(true);

        const latePublication = createAudioPublication("aud-late");

        await act(async () => {
            room.emit(RoomEvent.TrackPublished, latePublication);
        });

        expect(latePublication.setSubscribed).toHaveBeenCalledWith(true);

        await act(async () => {
            room.emit(RoomEvent.TrackSubscribed, latePublication.track, latePublication);
        });

        const attachedSids = Array.from(container.querySelectorAll("audio[data-lk-track-sid]"))
            .map((node) => node.getAttribute("data-lk-track-sid"))
            .filter((value): value is string => typeof value === "string" && value.length > 0);

        expect(attachedSids).toContain("aud-initial");
        expect(attachedSids).toContain("aud-late");
        expect(playAttempts).toContain("aud-late");
    });
});

