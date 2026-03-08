import { describe, expect, it } from "vitest";

import { mxidLocalpart, tokenizeMatrixMentions } from "../../../../src/ui/mentions/mentionTokens";

describe("mxidLocalpart", () => {
    it("returns localpart for valid mxid", () => {
        expect(mxidLocalpart("@alice:example.org")).toBe("alice");
    });

    it("returns original value when localpart cannot be extracted", () => {
        expect(mxidLocalpart("@:example.org")).toBe("@:example.org");
    });
});

describe("tokenizeMatrixMentions", () => {
    it("tokenizes a mention and trailing punctuation", () => {
        const segments = tokenizeMatrixMentions("Hi @alice:example.org!");

        expect(segments).toEqual([
            { type: "text", value: "Hi " },
            { type: "mention", userId: "@alice:example.org" },
            { type: "text", value: "!" },
        ]);
    });

    it("tokenizes multiple mentions in one message", () => {
        const segments = tokenizeMatrixMentions("@alice:hs and @bob:hs.");

        expect(segments).toEqual([
            { type: "mention", userId: "@alice:hs" },
            { type: "text", value: " and " },
            { type: "mention", userId: "@bob:hs" },
            { type: "text", value: "." },
        ]);
    });

    it("returns a single text segment when no mention exists", () => {
        const segments = tokenizeMatrixMentions("No mentions here.");
        expect(segments).toEqual([{ type: "text", value: "No mentions here." }]);
    });
});
