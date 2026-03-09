export const SPACE_EMOJI_PACK_EVENT_TYPE = "com.heorot.emoji_pack";
export const PERSONAL_EMOJI_PACK_EVENT_TYPE = "com.heorot.emoji_pack";

export const REACTION_SHORTCODE_FIELD_STABLE = "shortcode";
export const REACTION_SHORTCODE_FIELD_UNSTABLE = "com.beeper.reaction.shortcode";

export const REACTION_IMAGE_SETTING_KEY = "feature_render_reaction_images";

export interface EmojiDefinition {
    url: string;
    name: string;
    created_by?: string;
    created_ts?: number;
}

export interface EmojiPackContent {
    version: 1;
    emojis: Record<string, EmojiDefinition>;
}

export interface ResolvedEmoji {
    shortcode: string;
    url: string;
    name: string;
}

export interface EmojiPackLookup {
    shortcode: string;
    emoji: EmojiDefinition;
}

export type EmojiPackTarget =
    | { kind: "space"; spaceId: string }
    | { kind: "personal" };
