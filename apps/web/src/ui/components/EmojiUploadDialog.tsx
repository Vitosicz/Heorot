import React, { useEffect, useMemo, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";

import {
    normalizeEmojiShortcode,
    upsertPersonalEmoji,
    upsertSpaceEmoji,
} from "../emoji/EmojiPackStore";
import type { EmojiPackTarget } from "../emoji/EmojiPackTypes";

interface EmojiUploadDialogProps {
    client: MatrixClient;
    target: EmojiPackTarget;
    open: boolean;
    onClose: () => void;
    onUploaded?: () => void;
}

const DEFAULT_MAX_UPLOAD_SIZE = 2 * 1024 * 1024;

function formatBytes(value: number): string {
    if (value >= 1024 * 1024) {
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (value >= 1024) {
        return `${Math.round(value / 1024)} KB`;
    }
    return `${value} B`;
}

function getUploadSizeLimit(config: unknown): number {
    if (!config || typeof config !== "object") {
        return DEFAULT_MAX_UPLOAD_SIZE;
    }

    const record = config as Record<string, unknown>;
    const size = record["m.upload.size"];
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
        return DEFAULT_MAX_UPLOAD_SIZE;
    }

    return Math.floor(size);
}

export function EmojiUploadDialog({
    client,
    target,
    open,
    onClose,
    onUploaded,
}: EmojiUploadDialogProps): React.ReactElement | null {
    const [file, setFile] = useState<File | null>(null);
    const [shortcodeInput, setShortcodeInput] = useState("");
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [uploadLimitBytes, setUploadLimitBytes] = useState(DEFAULT_MAX_UPLOAD_SIZE);

    useEffect(() => {
        if (!open) {
            return;
        }

        setFile(null);
        setShortcodeInput("");
        setError(null);
        setUploading(false);
    }, [open]);

    useEffect(() => {
        if (!open) {
            return;
        }

        let cancelled = false;

        const loadMediaConfig = async (): Promise<void> => {
            try {
                const config = await client.getMediaConfig();
                if (!cancelled) {
                    setUploadLimitBytes(getUploadSizeLimit(config));
                }
            } catch {
                if (!cancelled) {
                    setUploadLimitBytes(DEFAULT_MAX_UPLOAD_SIZE);
                }
            }
        };

        void loadMediaConfig();

        return () => {
            cancelled = true;
        };
    }, [client, open]);

    const dialogTitle = useMemo(
        () => (target.kind === "space" ? "Upload space emoji" : "Upload personal emoji"),
        [target.kind],
    );

    if (!open) {
        return null;
    }

    const onUpload = async (): Promise<void> => {
        if (!file) {
            setError("Pick an image first.");
            return;
        }

        if (!["image/png", "image/webp", "image/gif", "image/jpeg"].includes(file.type)) {
            setError("Only PNG/WEBP/GIF/JPEG images are supported.");
            return;
        }

        if (file.size > uploadLimitBytes) {
            setError(`File is too large. Limit is ${formatBytes(uploadLimitBytes)}.`);
            return;
        }

        const normalizedShortcode = normalizeEmojiShortcode(shortcodeInput);
        if (!/^:[a-z0-9_+\-]+:$/.test(normalizedShortcode)) {
            setError("Shortcode must look like :kekw: (letters/numbers/_+-).");
            return;
        }

        setUploading(true);
        setError(null);
        try {
            const uploadResponse = await client.uploadContent(file, {
                includeFilename: true,
                type: file.type || "application/octet-stream",
                name: file.name,
            });

            const mxcUrl = uploadResponse.content_uri;
            if (typeof mxcUrl !== "string" || !mxcUrl.startsWith("mxc://")) {
                throw new Error("Homeserver did not return a valid MXC URL.");
            }

            const userId = client.getUserId() ?? undefined;
            const createdTs = Date.now();
            if (target.kind === "space") {
                await upsertSpaceEmoji(client, target.spaceId, normalizedShortcode, {
                    url: mxcUrl,
                    name: normalizedShortcode.slice(1, -1),
                    created_by: userId,
                    created_ts: createdTs,
                });
            } else {
                await upsertPersonalEmoji(client, normalizedShortcode, {
                    url: mxcUrl,
                    name: normalizedShortcode.slice(1, -1),
                    created_by: userId,
                    created_ts: createdTs,
                });
            }

            onUploaded?.();
            onClose();
        } catch (uploadError) {
            setError(uploadError instanceof Error ? uploadError.message : "Failed to upload emoji.");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="emoji-upload-overlay" role="dialog" aria-modal="true" aria-label={dialogTitle}>
            <div className="emoji-upload-dialog">
                <h2>{dialogTitle}</h2>
                <p className="emoji-upload-subtitle">
                    Upload limit: {formatBytes(uploadLimitBytes)}. Emoji is stored in{" "}
                    {target.kind === "space" ? "this Space pack" : "your personal pack"}.
                </p>
                <label className="emoji-upload-label">
                    Image
                    <input
                        type="file"
                        accept="image/png,image/webp,image/gif,image/jpeg"
                        onChange={(event) => {
                            setFile(event.target.files?.[0] ?? null);
                        }}
                        disabled={uploading}
                    />
                </label>
                <label className="emoji-upload-label">
                    Shortcode
                    <input
                        type="text"
                        value={shortcodeInput}
                        onChange={(event) => setShortcodeInput(event.target.value)}
                        placeholder="kekw"
                        disabled={uploading}
                    />
                </label>
                {error ? <p className="emoji-upload-error">{error}</p> : null}
                <div className="emoji-upload-actions">
                    <button type="button" className="emoji-upload-cancel" onClick={onClose} disabled={uploading}>
                        Cancel
                    </button>
                    <button type="button" className="emoji-upload-save" onClick={() => void onUpload()} disabled={uploading}>
                        {uploading ? "Uploading..." : "Upload emoji"}
                    </button>
                </div>
            </div>
        </div>
    );
}
