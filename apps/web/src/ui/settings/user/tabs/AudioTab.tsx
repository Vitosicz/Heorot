import React, { useEffect, useMemo, useRef, useState } from "react";
import { Room } from "livekit-client";

import type { AudioSettings } from "../settingsStore";

interface AudioTabProps {
    settings: AudioSettings;
    onChange: (settings: AudioSettings) => void;
}

function formatDeviceLabel(device: MediaDeviceInfo): string {
    return device.label && device.label.trim().length > 0 ? device.label : `${device.kind} (${device.deviceId.slice(0, 6)})`;
}

function buildMicConstraints(settings: AudioSettings): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
        autoGainControl: settings.autoGainControlEnabled,
        echoCancellation: settings.echoCancellationEnabled,
        noiseSuppression: settings.noiseSuppressionEnabled,
    };
    if (settings.preferredAudioInputId && settings.preferredAudioInputId !== "default") {
        constraints.deviceId = { exact: settings.preferredAudioInputId };
    }
    (constraints as MediaTrackConstraints & { voiceIsolation?: boolean }).voiceIsolation = settings.voiceIsolationEnabled;
    return constraints;
}

export function AudioTab({ settings, onChange }: AudioTabProps): React.ReactElement {
    const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
    const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [micTestActive, setMicTestActive] = useState(false);
    const [micLevel, setMicLevel] = useState(0);
    const streamRef = useRef<MediaStream | null>(null);
    const contextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const rafRef = useRef<number | null>(null);
    const playbackAudioRef = useRef<HTMLAudioElement | null>(null);

    const supportsAudioOutputSelection = useMemo(() => "setSinkId" in HTMLMediaElement.prototype, []);

    useEffect(() => {
        let disposed = false;
        const loadDevices = async (): Promise<void> => {
            setError(null);
            try {
                const [inputs, outputs] = await Promise.all([
                    Room.getLocalDevices("audioinput"),
                    Room.getLocalDevices("audiooutput"),
                ]);
                if (disposed) {
                    return;
                }
                setAudioInputs(inputs);
                setAudioOutputs(outputs);
            } catch (deviceError) {
                if (!disposed) {
                    setError(deviceError instanceof Error ? deviceError.message : "Unable to enumerate audio devices.");
                }
            }
        };

        void loadDevices();
        return () => {
            disposed = true;
        };
    }, []);

    useEffect(
        () => () => {
            if (rafRef.current !== null) {
                cancelAnimationFrame(rafRef.current);
            }
            streamRef.current?.getTracks().forEach((track) => track.stop());
            contextRef.current?.close().catch(() => undefined);
            playbackAudioRef.current?.pause();
        },
        [],
    );

    const stopMicTest = (): void => {
        if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        contextRef.current?.close().catch(() => undefined);
        contextRef.current = null;
        analyserRef.current = null;
        playbackAudioRef.current?.pause();
        playbackAudioRef.current = null;
        setMicLevel(0);
        setMicTestActive(false);
    };

    const startMicTest = async (): Promise<void> => {
        stopMicTest();
        setError(null);

        try {
            const constraints: MediaStreamConstraints = {
                audio: buildMicConstraints(settings),
                video: false,
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            streamRef.current = stream;

            const context = new AudioContext();
            contextRef.current = context;
            const source = context.createMediaStreamSource(stream);
            const analyser = context.createAnalyser();
            analyser.fftSize = 512;
            analyserRef.current = analyser;
            source.connect(analyser);

            if (settings.micTestLoopbackEnabled) {
                const audio = new Audio();
                audio.autoplay = true;
                audio.muted = false;
                audio.srcObject = stream;
                playbackAudioRef.current = audio;
                if (supportsAudioOutputSelection && settings.preferredAudioOutputId !== "default") {
                    const sinkSetter = audio as HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };
                    await sinkSetter.setSinkId?.(settings.preferredAudioOutputId);
                }
                void audio.play().catch(() => undefined);
            }

            const buffer = new Uint8Array(analyser.frequencyBinCount);
            const updateLevel = (): void => {
                if (!analyserRef.current) {
                    return;
                }
                analyserRef.current.getByteTimeDomainData(buffer);
                let peak = 0;
                for (let index = 0; index < buffer.length; index += 1) {
                    const normalized = Math.abs((buffer[index]! - 128) / 128);
                    if (normalized > peak) {
                        peak = normalized;
                    }
                }
                setMicLevel(Math.min(1, peak * 1.8));
                rafRef.current = requestAnimationFrame(updateLevel);
            };

            setMicTestActive(true);
            rafRef.current = requestAnimationFrame(updateLevel);
        } catch (micError) {
            stopMicTest();
            setError(micError instanceof Error ? micError.message : "Unable to start microphone test.");
        }
    };

    return (
        <div className="settings-tab">
            <h2 className="settings-tab-title">Audio</h2>
            <p className="settings-tab-description">Microphone, speaker, and voice processing settings.</p>

            <label className="settings-field">
                <span>Microphone input</span>
                <select
                    className="room-dialog-input"
                    value={settings.preferredAudioInputId}
                    onChange={(event) => onChange({ ...settings, preferredAudioInputId: event.target.value })}
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
                <span>Speaker output</span>
                <select
                    className="room-dialog-input"
                    value={settings.preferredAudioOutputId}
                    onChange={(event) => onChange({ ...settings, preferredAudioOutputId: event.target.value })}
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

            {!supportsAudioOutputSelection ? (
                <p className="settings-inline-note">Output selection is not supported in this browser.</p>
            ) : null}

            <label className="settings-field">
                <span>Voice quality profile</span>
                <select
                    className="room-dialog-input"
                    value={settings.micProfile}
                    onChange={(event) =>
                        onChange({
                            ...settings,
                            micProfile: event.target.value === "music" ? "music" : "speech",
                        })
                    }
                >
                    <option value="speech">Speech (recommended)</option>
                    <option value="music">Music</option>
                </select>
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.echoCancellationEnabled}
                    onChange={(event) => onChange({ ...settings, echoCancellationEnabled: event.target.checked })}
                />
                Echo cancellation
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.noiseSuppressionEnabled}
                    onChange={(event) => onChange({ ...settings, noiseSuppressionEnabled: event.target.checked })}
                />
                Noise suppression
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.autoGainControlEnabled}
                    onChange={(event) => onChange({ ...settings, autoGainControlEnabled: event.target.checked })}
                />
                Auto gain control
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.voiceIsolationEnabled}
                    onChange={(event) => onChange({ ...settings, voiceIsolationEnabled: event.target.checked })}
                />
                Voice isolation (experimental)
            </label>

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={settings.micTestLoopbackEnabled}
                    onChange={(event) => onChange({ ...settings, micTestLoopbackEnabled: event.target.checked })}
                />
                Mic test loopback (play your microphone to selected output)
            </label>

            <div className="settings-section-card">
                <h3>Microphone test</h3>
                <div className="settings-audio-meter" aria-label="Microphone level meter">
                    <div className="settings-audio-meter-fill" style={{ width: `${Math.round(micLevel * 100)}%` }} />
                </div>
                <div className="settings-actions-row">
                    <button
                        type="button"
                        className="settings-button"
                        onClick={() => {
                            void (micTestActive ? Promise.resolve(stopMicTest()) : startMicTest());
                        }}
                    >
                        {micTestActive ? "Stop test" : "Start test"}
                    </button>
                </div>
            </div>


            {error ? <p className="settings-inline-error">{error}</p> : null}
        </div>
    );
}
