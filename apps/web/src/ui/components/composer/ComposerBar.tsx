import React from "react";

interface ComposerBarProps {
    disabled: boolean;
    dragActive: boolean;
    value: string;
    placeholder: string;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    emojiButtonRef: React.RefObject<HTMLButtonElement | null>;
    onChange: (value: string, caret: number | null) => void;
    onCursorActivity: (caret: number | null) => void;
    onBlur: (event: React.FocusEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
    onAttach: () => void;
    onToggleEmoji: () => void;
    emojiPicker: React.ReactNode;
}

export function ComposerBar({
    disabled,
    dragActive,
    value,
    placeholder,
    textareaRef,
    emojiButtonRef,
    onChange,
    onCursorActivity,
    onBlur,
    onKeyDown,
    onPaste,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onAttach,
    onToggleEmoji,
    emojiPicker,
}: ComposerBarProps): React.ReactElement {
    return (
        <div className="composer-bar">
            <button
                type="button"
                className="composer-plus-button"
                onClick={onAttach}
                disabled={disabled}
                aria-label="Upload attachment"
                title="Upload attachment"
            >
                +
            </button>
            <div
                className={`composer-input-shell${dragActive ? " is-drag-active" : ""}`}
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
            >
                <textarea
                    ref={textareaRef}
                    className="composer-textarea"
                    value={value}
                    onChange={(event) => onChange(event.target.value, event.target.selectionStart)}
                    onSelect={(event) => onCursorActivity(event.currentTarget.selectionStart)}
                    onClick={(event) => onCursorActivity(event.currentTarget.selectionStart)}
                    onKeyUp={(event) => onCursorActivity(event.currentTarget.selectionStart)}
                    onBlur={onBlur}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    placeholder={placeholder}
                    disabled={disabled}
                    rows={1}
                />
                <div className="composer-input-actions">
                    <div className="composer-emoji-anchor">
                        <button
                            ref={emojiButtonRef}
                            type="button"
                            className="composer-action-button"
                            onClick={onToggleEmoji}
                            disabled={disabled}
                            aria-label="Open emoji picker"
                            title="Emoji"
                        >
                            {"\u{1F604}"}
                        </button>
                        {emojiPicker}
                    </div>
                </div>
            </div>
        </div>
    );
}
