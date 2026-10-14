/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const settings = definePluginSettings({
    fakeMute: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Appear muted to others while fake deafen is on.",
        onChange: () => { },
    },
    fakeDeafen: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Appear deafened to others while fake deafen is on.",
        onChange: () => { },
    },
    enableKeybind: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Toggle with Ctrl+Shift+Q.",
    },
    currentlyEnabled: {
        type: OptionType.BOOLEAN,
        default: false,
        hidden: true,
        description: "Internal toggle state.",
    },
});
