import { describe, expect, it, vi } from "vitest";

import { formatMessageWithEmojis, type FormattedTextMessageContent } from "../../../../src/ui/emoji/formatMessageWithEmojis";

function createClient(hasRoom = true): {
    getRoom: ReturnType<typeof vi.fn>;
    mxcUrlToHttp: ReturnType<typeof vi.fn>;
} {
    const room = hasRoom ? ({ roomId: "!room:example.org" } as const) : null;

    return {
        getRoom: vi.fn(() => room),
        mxcUrlToHttp: vi.fn((mxc: string, width?: number, height?: number) => {
            const baseUrl = `https://cdn.example/${mxc.replace("mxc://", "")}`;
            if (typeof width === "number" && typeof height === "number") {
                return `${baseUrl}?w=${width}&h=${height}`;
            }
            return baseUrl;
        }),
    };
}

function expectFormattedBody(content: FormattedTextMessageContent): string {
    if (!("formatted_body" in content)) {
        throw new Error("Expected formatted HTML content.");
    }

    return content.formatted_body;
}

describe("formatMessageWithEmojis", () => {
    it("returns plain body when room is missing", async () => {
        const client = createClient(false);
        const resolver = vi.fn(async () => null);

        const result = await formatMessageWithEmojis(
            "hello :party:",
            { roomId: "!missing:example.org", activeSpaceId: null },
            resolver,
            client as any,
        );

        expect(result).toEqual({ body: "hello :party:" });
        expect(resolver).not.toHaveBeenCalled();
    });

    it("returns plain body when no shortcode token exists", async () => {
        const client = createClient(true);
        const resolver = vi.fn(async () => null);

        const result = await formatMessageWithEmojis("hello world", { roomId: "!room:example.org" }, resolver, client as any);
        expect(result).toEqual({ body: "hello world" });
        expect(resolver).not.toHaveBeenCalled();
    });

    it("replaces shortcode with emoji html image", async () => {
        const client = createClient(true);
        const resolver = vi.fn(async (_client, _room, token: string) => {
            if (token === ":party:") {
                return {
                    shortcode: ":party:",
                    url: "mxc://example.org/party",
                    name: "party",
                };
            }
            return null;
        });

        const result = await formatMessageWithEmojis(
            "Say :party: now",
            { roomId: "!room:example.org", activeSpaceId: "!space:example.org" },
            resolver,
            client as any,
        );

        const html = expectFormattedBody(result);
        expect(result.body).toBe("Say :party: now");
        expect(html).toContain("data-mx-emoticon=\"true\"");
        expect(html).toContain("alt=\":party:\"");
        expect(html).toContain("src=\"https://cdn.example/example.org/party?w=24&amp;h=24\"");
        expect(resolver).toHaveBeenCalledTimes(1);
    });

    it("does not replace shortcode tokens inside URLs", async () => {
        const client = createClient(true);
        const resolver = vi.fn(async () => ({
            shortcode: ":party:",
            url: "mxc://example.org/party",
            name: "party",
        }));

        const result = await formatMessageWithEmojis(
            "https://example.org/:party:/foo and :party:",
            { roomId: "!room:example.org" },
            resolver,
            client as any,
        );

        const html = expectFormattedBody(result);
        const matches = html.match(/data-mx-emoticon/g) ?? [];

        expect(matches).toHaveLength(1);
        expect(html).toContain("https://example.org/:party:");
    });

    it("escapes html around replacements and preserves line breaks", async () => {
        const client = createClient(true);
        const resolver = vi.fn(async () => ({
            shortcode: ":party:",
            url: "mxc://example.org/party",
            name: "party",
        }));

        const result = await formatMessageWithEmojis("<b>:party:</b>\nnext", { roomId: "!room:example.org" }, resolver, client as any);
        const html = expectFormattedBody(result);

        expect(html).toContain("&lt;b&gt;");
        expect(html).toContain("&lt;/b&gt;<br>next");
        expect(html).toContain("data-mx-emoticon=\"true\"");
    });

    it("resolves duplicated shortcodes only once", async () => {
        const client = createClient(true);
        const resolver = vi.fn(async () => ({
            shortcode: ":party:",
            url: "mxc://example.org/party",
            name: "party",
        }));

        await formatMessageWithEmojis(":party: :party: :party:", { roomId: "!room:example.org" }, resolver, client as any);
        expect(resolver).toHaveBeenCalledTimes(1);
    });
});
