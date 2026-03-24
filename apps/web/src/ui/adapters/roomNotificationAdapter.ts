import {
    ConditionKind,
    PushRuleActionName,
    PushRuleKind,
    type IPushRule,
    type MatrixClient,
} from "matrix-js-sdk/src/matrix";

export enum RoomNotificationMode {
    Default = "default",
    AllMessages = "all_messages",
    MentionsOnly = "mentions_only",
    Mute = "mute",
}

type OverridePushRule = IPushRule & { conditions?: Array<{ kind?: unknown; key?: unknown; pattern?: unknown }> };

function isMuteRule(rule: IPushRule): boolean {
    return (
        rule.actions.length === 0 ||
        (rule.actions.length === 1 && rule.actions[0] === PushRuleActionName.DontNotify)
    );
}

function findOverrideMuteRule(client: MatrixClient, roomId: string): IPushRule | null {
    const overrideRules = (client.pushRules?.global?.override ?? []) as OverridePushRule[];
    for (const rule of overrideRules) {
        if (!rule.enabled || !isMuteRule(rule)) {
            continue;
        }
        if (rule.conditions?.length !== 1) {
            continue;
        }
        const condition = rule.conditions[0];
        if (
            condition.kind === ConditionKind.EventMatch &&
            condition.key === "room_id" &&
            condition.pattern === roomId
        ) {
            return rule;
        }
    }
    return null;
}

function getRoomPushRule(client: MatrixClient, roomId: string): IPushRule | null {
    try {
        return client.getRoomPushRule("global", roomId) ?? null;
    } catch {
        return null;
    }
}

function isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }
    const errcode = (error as { errcode?: unknown }).errcode;
    if (errcode === "M_NOT_FOUND") {
        return true;
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.toLowerCase().includes("not found");
}

async function deletePushRuleIfExists(client: MatrixClient, kind: PushRuleKind, ruleId: string): Promise<void> {
    try {
        await client.deletePushRule("global", kind, ruleId);
    } catch (error) {
        if (isNotFoundError(error)) {
            return;
        }
        throw error;
    }
}

export function getRoomNotificationMode(client: MatrixClient, roomId: string): RoomNotificationMode {
    if (client.isGuest()) {
        return RoomNotificationMode.Default;
    }

    if (findOverrideMuteRule(client, roomId)) {
        return RoomNotificationMode.Mute;
    }

    const roomRule = getRoomPushRule(client, roomId);
    if (!roomRule || !roomRule.enabled) {
        return RoomNotificationMode.Default;
    }

    const hasNotifyAction = roomRule.actions.some((action) => action === PushRuleActionName.Notify);
    return hasNotifyAction ? RoomNotificationMode.AllMessages : RoomNotificationMode.MentionsOnly;
}

export async function setRoomNotificationMode(
    client: MatrixClient,
    roomId: string,
    mode: RoomNotificationMode,
): Promise<void> {
    const roomRule = getRoomPushRule(client, roomId);
    const overrideMuteRule = findOverrideMuteRule(client, roomId);

    const cleanupTasks: Promise<void>[] = [];
    if (roomRule) {
        cleanupTasks.push(deletePushRuleIfExists(client, PushRuleKind.RoomSpecific, roomRule.rule_id));
    }
    if (overrideMuteRule) {
        cleanupTasks.push(deletePushRuleIfExists(client, PushRuleKind.Override, overrideMuteRule.rule_id));
    }
    await Promise.all(cleanupTasks);

    if (mode === RoomNotificationMode.Default) {
        return;
    }

    if (mode === RoomNotificationMode.Mute) {
        await client.addPushRule("global", PushRuleKind.Override, roomId, {
            conditions: [
                {
                    kind: ConditionKind.EventMatch,
                    key: "room_id",
                    pattern: roomId,
                },
            ],
            actions: [PushRuleActionName.DontNotify],
        });
        return;
    }

    await client.addPushRule("global", PushRuleKind.RoomSpecific, roomId, {
        actions:
            mode === RoomNotificationMode.AllMessages
                ? [PushRuleActionName.Notify]
                : [PushRuleActionName.DontNotify],
    });
}

