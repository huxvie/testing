import { React, ReactNative, stylesheet } from "@vendetta/metro/common";
import { Forms } from "@vendetta/ui/components";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";

const { FormSection, FormDivider, FormInput, FormSwitchRow } = Forms;

export default function SilentEditSettings() {
    useProxy(storage);

    storage.replacementText ??= "** **";
    storage.suppressNotifications ??= true;

    return (
        <>
            <FormSection title="Behavior">
                <FormInput
                    title="Default Replacement Text"
                    placeholder="** **"
                    value={storage.replacementText}
                    onChangeText={(v: string) => (storage.replacementText = v)}
                />
                <FormDivider />
                <FormSwitchRow
                    label="Suppress Notifications"
                    subLabel="Prevents pinging mentioned users when replacing the message."
                    value={!!storage.suppressNotifications}
                    onValueChange={(v: boolean) => (storage.suppressNotifications = v)}
                />
            </FormSection>
        </>
    );
}