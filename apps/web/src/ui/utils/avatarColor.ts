function hashString(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index++) {
        hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }

    return Math.abs(hash);
}

export function getAvatarColor(userId: string): string {
    const hue = hashString(userId) % 360;
    return `hsl(${hue}, 60%, 45%)`;
}

