Hooks.once('init', async function() {
	console.log('pf2e-aon-import | Initializing AoN import module');
	// Add a Scene Control button to trigger the AoN import dialog
	Hooks.on('getSceneControlButtons', controls => {
		// Only show to GMs
		controls.tokens.tools.aonimport = {
					name: 'aonimport',
					title: 'Import AoN File',
					icon: 'fas fa-file-upload',
					button: true,
					visible: game.user.isGM,
					onChange: async () => {
						try {
							if (!window.AoNImport) {
								ui.notifications?.warn?.('AoNImport not available');
								return;
							}
							const result = await window.AoNImport.openImportDialog({ compile: true, retrieveDocument: false });
							if (result) ui.notifications?.info(`AoN Import: parsed ${result.parsed.length} items`);

							const actor = await window.AoNImport.createMerchantFromMatches({
								actorName: 'AoN Merchant',
							});
							if (actor) {
								ui.notifications?.info(`AoN Import: created Merchant actor "${actor.name}" with ${actor.itemTypes.inventory.length} items`)
							};
						} catch (err) {
							console.error('AoN Import button error', err);
							ui.notifications?.error?.('AoN Import failed');
						}
					}
				};
	});
});

Hooks.once('ready', async function() {
	const MODULE_ID = 'pf2e-aon-import';
	try {
		// Prefer attaching via the module entry so other modules/scripts can access it
		if (typeof game !== 'undefined' && game.modules) {
			const mod = game.modules.get(MODULE_ID);
			if (mod) {
				mod.api = window.AoNImport || {};
				console.log(`${MODULE_ID} | AoNImport API attached to module.api`);
				return;
			}
		}
		// Fallback: attach to global window for direct console usage
		window.AoNImport = window.AoNImport || {};
		console.warn(`${MODULE_ID} | module object not found; AoNImport available at window.AoNImport`);
	} catch (err) {
		console.error('pf2e-aon-import | Error attaching AoNImport API', err);
	}
});
