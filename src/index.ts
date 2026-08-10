import { findByProps } from "@vendetta/metro";
import { before, after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { logger } from "@vendetta";
import { React } from "@vendetta/metro/common";
import { findInReactTree } from "@vendetta/utils";
import { getAssetIDByName } from "@vendetta/ui/assets";
import Settings from "./Settings";

const ActionSheet = findByProps("openLazy", "hideActionSheet");
const { ActionSheetRow } = findByProps("ActionSheetRow");

const EditIcon =
    getAssetIDByName("ic_message_edit") ??
    getAssetIDByName("PencilIcon") ??
    getAssetIDByName("pencil") ??
    getAssetIDByName("ic_pencil");

// Track which message is being silently edited
let pendingSilentEdit: { channelId: string; messageId: string } | null = null;

// --- Core method: POST with nonce trick (no \'(edited)\', no delete) ---
async function silentEditMessage(channelId: string, messageId: string, newContent: string) {
    const RestAPI = findByProps("get", "post", "del", "patch");
    try {
        const suppressNotifications: boolean = storage.suppressNotifications ?? true;

        await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                content: newContent,
                flags: suppressNotifications ? 4096 : 0,
                mobile_network_type: "unknown",
                nonce: messageId,
                tts: false,
            },
        });

        logger.log("[SilentEdit] Success!");
    } catch (err) {
        logger.log("[SilentEdit] Error: " + String(err));
    }
}

// --- Intercept Discord\'s editMessage so we can hijack the submission ---
const MessageActions = findByProps("editMessage");
let originalEditMessage: ((...args: any[]) => any) | null = null;

if (MessageActions?.editMessage) {
    originalEditMessage = MessageActions.editMessage;
    (MessageActions as any).editMessage = function (this: any, ...args: any[]) {
        if (pendingSilentEdit) {
            const cid: string = args[0];
            const mid: string = args[1];

            if (cid === pendingSilentEdit.channelId && mid === pendingSilentEdit.messageId) {
                // Extract the new content from the arguments
                let newContent = "";
                const third = args[2];
                if (typeof third === "string") {
                    newContent = third;
                } else if (third && typeof third === "object") {
                    newContent = third.content ?? third.message?.content ?? "";
                }

                logger.log("[SilentEdit] Intercepted editMessage, content: " + newContent);
                pendingSilentEdit = null;
                silentEditMessage(cid, mid, newContent);
                return; // skip the real edit
            }
        }
        return originalEditMessage!.apply(this, args);
    };
    logger.log("[SilentEdit] Patched editMessage");
} else {
    logger.warn("[SilentEdit] editMessage not found");
}

let unpatchOpenLazy: (() => void) | null = null;

export default {
    onLoad() {
        storage.suppressNotifications ??= true;

        unpatchOpenLazy = before("openLazy", ActionSheet, ([comp, args, msg]) => {
            if (args !== "MessageLongPressActionSheet" || !msg?.message) return;

            const UserStore = findByProps("getCurrentUser");
            const currentUser = UserStore?.getCurrentUser();
            if (!currentUser || msg.message.author?.id !== currentUser.id) return;

            const channelId: string = msg.message.channel_id;
            const messageId: string = msg.message.id;

            comp.then((instance: any) => {
                const unpatch = after("default", instance, (_: any, component: any) => {
                    React.useEffect(() => () => { unpatch(); }, []);

                    const groups: any[] = findInReactTree(
                        component,
                        (c: any) => Array.isArray(c) && c[0]?.type?.name === "ActionSheetRowGroup"
                    );

                    if (!groups?.length) {
                        logger.warn("[SilentEdit] Could not find ActionSheetRowGroups");
                        return;
                    }

                    // Find the native Edit button\'s onPress handler
                    let nativeEditHandler: (() => void) | null = null;
                    for (let gi = 0; gi < groups.length; gi++) {
                        const groupChildren: any[] = findInReactTree(
                            groups[gi],
                            (c: any) => Array.isArray(c) && c.some((child: any) =>
                                child?.type?.name === "ActionSheetRow"
                            )
                        );
                        if (!groupChildren) continue;

                        const editRowIndex = groupChildren.findIndex((c: any) =>
                            c?.props?.label?.toLowerCase?.()?.includes?.("edit") ||
                            c?.props?.message?.toLowerCase?.()?.includes?.("edit")
                        );

                        if (editRowIndex >= 0) {
                            nativeEditHandler = groupChildren[editRowIndex]?.props?.onPress ?? null;
                            break;
                        }
                    }

                    const silentEditButton = React.createElement(ActionSheetRow, {
                        label: "Silent Edit",
                        destructive: true,
                        icon: React.createElement(ActionSheetRow.Icon, {
                            source: EditIcon,
                            color: "#ed4245",
                        }),
                        onPress: () => {
                            // Mark this message for silent edit interception
                            pendingSilentEdit = { channelId, messageId };
                            ActionSheet.hideActionSheet();

                            // Open the native edit UI so the user can type their edit
                            if (nativeEditHandler) {
                                nativeEditHandler();
                            } else {
                                // Fallback: try the internal editing module
                                const EditModule = findByProps("startEditingMessage", "endEditingMessage");
                                if (EditModule?.startEditingMessage) {
                                    EditModule.startEditingMessage(channelId, messageId);
                                } else {
                                    logger.log("[SilentEdit] No edit handler found.");
                                    pendingSilentEdit = null;
                                }
                            }
                        },
                    });

                    // Insert above the native Edit row
                    let inserted = false;
                    for (let gi = 0; gi < groups.length; gi++) {
                        const groupChildren: any[] = findInReactTree(
                            groups[gi],
                            (c: any) => Array.isArray(c) && c.some((child: any) =>
                                child?.type?.name === "ActionSheetRow"
                            )
                        );
                        if (!groupChildren) continue;

                        const editRowIndex = groupChildren.findIndex((c: any) =>
                            c?.props?.label?.toLowerCase?.()?.includes?.("edit") ||
                            c?.props?.message?.toLowerCase?.()?.includes?.("edit")
                        );

                        if (editRowIndex >= 0) {
                            groupChildren.splice(editRowIndex, 0, silentEditButton);
                            inserted = true;
                            break;
                        }
                    }

                    if (!inserted) {
                        logger.warn("[SilentEdit] Edit row not found, inserting before last group");
                        const insertAt = Math.max(0, groups.length - 1);
                        groups.splice(insertAt, 0,
                            React.createElement(ActionSheetRow.Group, null, silentEditButton)
                        );
                    }
                });
            });
        });

        logger.log("[SilentEdit] Loaded.");
    },

    onUnload() {
        unpatchOpenLazy?.();
        unpatchOpenLazy = null;

        // Restore original editMessage
        if (MessageActions && originalEditMessage) {
            (MessageActions as any).editMessage = originalEditMessage;
            originalEditMessage = null;
        }

        pendingSilentEdit = null;
        logger.log("[SilentEdit] Unloaded.");
    },

    settings: Settings,
};
