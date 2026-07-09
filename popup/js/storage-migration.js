/**
 * One-time local storage key migration for users upgrading from the previous key namespace.
 */
(function attachFormPilotStorageMigration(root) {
    const NEW_STORAGE_KEYS = Object.freeze({
        storage: 'formPilotCachedData',
        theme: 'formPilotTheme',
        locked: 'formPilotLockedFields',
        settings: 'formPilotSettings',
        archives: 'formPilotArchives',
        autoClear: 'formPilotAutoClear',
        history: 'formPilotHistory',
        geoapify: 'formPilotGeoapifyKey',
        myProfile: 'formPilotMyProfile',
        aiMode: 'formPilotUseAI',
        fillEmptyOnly: 'formPilotFillEmptyOnly',
        addressApiEnabled: 'formPilotAddressApiEnabled',
        profileSections: 'formPilotProfileSections'
    });

    const PREVIOUS_PREFIX = ['geo', 'Fill'].join('');
    const CURRENT_PREFIX = 'formPilot';
    const LEGACY_STORAGE_KEYS = Object.freeze(Object.fromEntries(
        Object.entries(NEW_STORAGE_KEYS).map(([name, key]) => [
            name,
            PREVIOUS_PREFIX + key.slice(CURRENT_PREFIX.length)
        ])
    ));

    async function migrateLegacyStorageKeys(storageArea = root.chrome?.storage?.local) {
        if (!storageArea?.get || !storageArea?.set || !storageArea?.remove) {
            return { migrated: 0, removed: 0 };
        }

        const legacyKeys = Object.values(LEGACY_STORAGE_KEYS);
        const newKeys = Object.values(NEW_STORAGE_KEYS);
        const snapshot = await storageArea.get([...legacyKeys, ...newKeys]);
        const updates = {};
        const removals = [];

        Object.entries(LEGACY_STORAGE_KEYS).forEach(([name, legacyKey]) => {
            const newKey = NEW_STORAGE_KEYS[name];
            if (!Object.prototype.hasOwnProperty.call(snapshot, legacyKey)) return;

            if (!Object.prototype.hasOwnProperty.call(snapshot, newKey)) {
                updates[newKey] = snapshot[legacyKey];
            }
            removals.push(legacyKey);
        });

        if (Object.keys(updates).length) {
            await storageArea.set(updates);
        }
        if (removals.length) {
            await storageArea.remove(removals);
        }

        return {
            migrated: Object.keys(updates).length,
            removed: removals.length
        };
    }

    root.FormPilotStorageMigration = Object.freeze({
        LEGACY_STORAGE_KEYS,
        NEW_STORAGE_KEYS,
        migrateLegacyStorageKeys
    });
})(typeof globalThis !== 'undefined' ? globalThis : window);
