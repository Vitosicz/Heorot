import React, { useRef, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import {
    getSupportedChannels,
    parseJsonExport,
    runJsonImport,
    type ChannelImportConfig,
    type JsonExport,
    type JsonExportChannel,
    type ImportProgress,
    type ImportResult,
    type ImportSignal,
} from "../../adapters/importJsonAdapter";
import { RoomDialog } from "./RoomDialog";

interface ImportJsonWizardProps {
    client: MatrixClient;
    open: boolean;
    onClose: () => void;
    onImported: (spaceId: string) => void;
}

type WizardStep = "select" | "configure" | "importing" | "done";

function defaultConfig(channel: JsonExportChannel): ChannelImportConfig {
    return { minPL: 0, isPublic: false, isEncrypted: channel.type !== "voice" };
}

function ImportChannelRow({
    channel,
    config,
    onChange,
}: {
    channel: JsonExportChannel;
    config: ChannelImportConfig;
    onChange: (val: ChannelImportConfig) => void;
}): React.ReactElement {
    const isVoice = channel.type === "voice";
    const icon = isVoice ? "đź”Š" : "#";
    return (
        <div className="import-tree-channel">
            <span className="import-tree-channel-icon">{icon}</span>
            <span className="import-tree-channel-name">{channel.name}</span>
            <div className="import-tree-channel-controls">
                <select
                    className="import-tree-channel-select"
                    value={config.isPublic ? "public" : "invite"}
                    onChange={(e) => onChange({ ...config, isPublic: e.target.value === "public" })}
                >
                    <option value="invite">Invite</option>
                    <option value="public">Public</option>
                </select>
                {!isVoice && (
                    <select
                        className="import-tree-channel-select"
                        value={config.isEncrypted ? "enc" : "plain"}
                        onChange={(e) => onChange({ ...config, isEncrypted: e.target.value === "enc" })}
                    >
                        <option value="enc">Encrypted</option>
                        <option value="plain">Unencrypted</option>
                    </select>
                )}
                <select
                    className="import-tree-channel-select"
                    value={config.minPL}
                    onChange={(e) => onChange({ ...config, minPL: Number(e.target.value) as 0 | 50 | 100 })}
                >
                    <option value={0}>Member</option>
                    <option value={50}>Mod</option>
                    <option value={100}>Admin</option>
                </select>
            </div>
        </div>
    );
}

export function ImportJsonWizard({
    client,
    open,
    onClose,
    onImported,
}: ImportJsonWizardProps): React.ReactElement | null {
    const [step, setStep] = useState<WizardStep>("select");
    const [exportData, setExportData] = useState<JsonExport | null>(null);
    const [emojiFiles, setEmojiFiles] = useState<Map<string, File>>(new Map());
    const [parseError, setParseError] = useState<string | null>(null);
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    const [result, setResult] = useState<ImportResult | null>(null);
    const [channelConfig, setChannelConfig] = useState<Record<string, ChannelImportConfig>>({});

    const jsonInputRef = useRef<HTMLInputElement>(null);
    const emojiInputRef = useRef<HTMLInputElement>(null);
    const signalRef = useRef<ImportSignal>({ cancelled: false });

    const resetState = (): void => {
        setStep("select");
        setExportData(null);
        setEmojiFiles(new Map());
        setParseError(null);
        setProgress(null);
        setResult(null);
        setChannelConfig({});
    };

    const handleClose = (): void => {
        if (step === "importing" && !signalRef.current.cancelled) return;
        resetState();
        onClose();
    };

    const handleJsonFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (): void => {
            try {
                const parsed = parseJsonExport(JSON.parse(reader.result as string));
                if (!parsed) {
                    setParseError("Invalid export format.");
                    setExportData(null);
                } else {
                    setParseError(null);
                    setExportData(parsed);
                }
            } catch {
                setParseError("Failed to parse JSON file.");
                setExportData(null);
            }
        };
        reader.readAsText(file);
    };

    const handleEmojiFolder = (event: React.ChangeEvent<HTMLInputElement>): void => {
        const files = event.target.files;
        if (!files) return;

        const map = new Map<string, File>();
        for (const file of Array.from(files)) {
            const filename = file.name.split("/").pop() ?? file.name;
            if (/\.(png|gif|webp|jpe?g)$/i.test(filename)) {
                map.set(filename, file);
            }
        }
        setEmojiFiles(map);
    };

    const startImport = async (): Promise<void> => {
        if (!exportData) return;
        signalRef.current = { cancelled: false };
        setStep("importing");
        try {
            const importResult = await runJsonImport(
                client,
                exportData,
                emojiFiles,
                (prog) => { setProgress({ ...prog }); },
                signalRef.current,
                channelConfig,
            );
            setResult(importResult);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unexpected error during import.";
            setResult({ spaceId: "", channelsCreated: 0, emojisUploaded: 0, errors: [msg] });
        }
        setStep("done");
    };

    const cancelImport = (): void => {
        signalRef.current.cancelled = true;
    };

    const supportedChannels = exportData ? getSupportedChannels(exportData) : [];
    const textChannelCount = supportedChannels.filter((ch) => ch.type === "text").length;
    const voiceChannelCount = supportedChannels.filter((ch) => ch.type === "voice").length;
    const emojiOkCount = exportData ? exportData.emojis.filter((e) => e.status === "ok").length : 0;
    const emojiReadyCount = exportData
        ? exportData.emojis.filter((e) => e.status === "ok" && emojiFiles.has(e.path.split("/").pop() ?? "")).length
        : 0;

    const progressPercent =
        progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

    const getTitle = (): string => {
        switch (step) {
            case "select": return "Import from JSON export";
            case "configure": return "Configure channels";
            case "importing": return "Importing...";
            case "done": return "Import complete";
        }
    };

    const renderFooter = (): React.ReactElement => {
        if (step === "select") {
            return (
                <>
                    <button type="button" className="room-dialog-button room-dialog-button-secondary" onClick={handleClose}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        className="room-dialog-button room-dialog-button-primary"
                        onClick={() => setStep("configure")}
                        disabled={!exportData}
                    >
                        Next
                    </button>
                </>
            );
        }

        if (step === "configure") {
            return (
                <>
                    <button
                        type="button"
                        className="room-dialog-button room-dialog-button-secondary"
                        onClick={() => setStep("select")}
                    >
                        Back
                    </button>
                    <button
                        type="button"
                        className="room-dialog-button room-dialog-button-primary"
                        onClick={() => void startImport()}
                    >
                        Start import
                    </button>
                </>
            );
        }

        if (step === "importing") {
            return (
                <button
                    type="button"
                    className="room-dialog-button room-dialog-button-secondary"
                    onClick={cancelImport}
                >
                    Cancel
                </button>
            );
        }

        if (step === "done") {
            return (
                <button
                    type="button"
                    className="room-dialog-button room-dialog-button-primary"
                    onClick={() => {
                        if (result?.spaceId) onImported(result.spaceId);
                        handleClose();
                    }}
                >
                    {result?.spaceId ? "Go to space" : "Close"}
                </button>
            );
        }

        return <></>;
    };

    return (
        <RoomDialog open={open} title={getTitle()} onClose={handleClose} footer={renderFooter()}>
            {step === "select" && (
                <div className="import-wizard-step">
                    <p className="room-dialog-muted">
                        Select the JSON export file and optionally the emoji folder.
                    </p>

                    <label className="room-dialog-field">
                        <span>Export JSON file</span>
                        <input
                            ref={jsonInputRef}
                            type="file"
                            accept=".json,application/json"
                            onChange={handleJsonFile}
                            className="room-dialog-input"
                        />
                    </label>

                    {parseError && <p className="room-dialog-error">{parseError}</p>}

                    {exportData && (
                        <div className="import-wizard-summary">
                            <p className="import-wizard-summary-name">{exportData.guild.name}</p>
                            <p className="room-dialog-muted">
                                {exportData.categories.length} categories &middot; {textChannelCount} text &middot;{" "}
                                {voiceChannelCount} voice &middot; {emojiOkCount} emoji
                            </p>
                        </div>
                    )}

                    <label className="room-dialog-field">
                        <span>Emoji folder (optional)</span>
                        <input
                            ref={emojiInputRef}
                            type="file"
                            accept="image/*"
                            // @ts-expect-error -- webkitdirectory not in standard TS types
                            webkitdirectory=""
                            onChange={handleEmojiFolder}
                            className="room-dialog-input"
                        />
                    </label>

                    {emojiFiles.size > 0 && (
                        <p className="room-dialog-muted">{emojiFiles.size} emoji image(s) loaded.</p>
                    )}
                </div>
            )}

            {step === "configure" && exportData && (
                <div className="import-wizard-step">
                    <p className="room-dialog-muted">
                        Review your channels and set the minimum power level required to post in each one.
                        {emojiOkCount > 0 && (
                            <>
                                {" "}Emoji pack:{" "}
                                {emojiReadyCount > 0
                                    ? `${emojiReadyCount} of ${emojiOkCount} emoji will be uploaded.`
                                    : `${emojiOkCount} available - select emoji folder to upload.`}
                            </>
                        )}
                    </p>
                    <div className="import-tree">
                        {(() => {
                            const catIds = new Set(exportData.categories.map((c) => c.id));
                            const uncategorized = getSupportedChannels(exportData)
                                .filter((ch) => !ch.category_id || !catIds.has(ch.category_id))
                                .sort((a, b) => a.position - b.position);
                            return uncategorized.map((ch) => (
                                <ImportChannelRow
                                    key={ch.id}
                                    channel={ch}
                                    config={channelConfig[ch.id] ?? defaultConfig(ch)}
                                    onChange={(val) => setChannelConfig((prev) => ({ ...prev, [ch.id]: val }))}
                                />
                            ));
                        })()}
                        {[...exportData.categories]
                            .sort((a, b) => a.position - b.position)
                            .map((cat) => {
                                const channels = getSupportedChannels(exportData)
                                    .filter((ch) => ch.category_id === cat.id)
                                    .sort((a, b) => a.position - b.position);
                                if (channels.length === 0) return null;
                                return (
                                    <div key={cat.id} className="import-tree-category">
                                        <div className="import-tree-category-name">{cat.name}</div>
                                        {channels.map((ch) => (
                                            <ImportChannelRow
                                                key={ch.id}
                                                channel={ch}
                                                config={channelConfig[ch.id] ?? defaultConfig(ch)}
                                                onChange={(val) =>
                                                    setChannelConfig((prev) => ({ ...prev, [ch.id]: val }))
                                                }
                                            />
                                        ))}
                                    </div>
                                );
                            })}
                    </div>
                    <p className="room-dialog-muted" style={{ marginTop: 8 }}>
                        All channels will be private. You can invite members after the import.
                    </p>
                </div>
            )}

            {step === "importing" && (
                <div className="import-wizard-step">
                    <p className="import-wizard-progress-message">{progress?.message ?? "Starting..."}</p>
                    <div className="import-wizard-progressbar">
                        <div className="import-wizard-progressbar-fill" style={{ width: `${progressPercent}%` }} />
                    </div>
                    <p className="room-dialog-muted">{progressPercent}%</p>
                </div>
            )}

            {step === "done" && result && (
                <div className="import-wizard-step">
                    {result.spaceId ? (
                        <>
                            <p className="import-wizard-success">Import successful!</p>
                            <ul className="import-wizard-list">
                                <li>Channels created: {result.channelsCreated}</li>
                                <li>Emoji uploaded: {result.emojisUploaded}</li>
                            </ul>
                        </>
                    ) : (
                        <p className="room-dialog-error">Import failed.</p>
                    )}
                    {result.errors.length > 0 && (
                        <details className="import-wizard-errors">
                            <summary className="room-dialog-muted">
                                {result.errors.length} warning(s)
                            </summary>
                            <ul className="import-wizard-error-list">
                                {result.errors.map((e, i) => (
                                    <li key={i}>{e}</li>
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}
        </RoomDialog>
    );
}
