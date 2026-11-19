# Synchronisation Linux du 19 novembre 2026

La branche `linux` reprend le contenu de `zaalis-labs-ide-main` à `81eaea9`, y compris les dix modifications locales suivies par Git. Les commits ont pour base `b7b1809` et l’historique ajouté est linéaire. Le dossier source et l’archive Linux d’origine sont conservés. Les données d’exécution, les binaires Windows générés et la configuration locale Cursor vide restent hors du commit.

- Le terminal utilise les chemins POSIX. Le serveur et le navigateur suivent XDG. Les lanceurs `.desktop` sont résolus dans les répertoires XDG, Flatpak et Snap. Les intégrations embarquent les binaires Linux de Node, GitHub CLI et cloudflared.
- Les VM Debian intégrées utilisent QEMU, KVM et OpenSSH. L’image Debian 12 téléchargée à l’activation est vérifiée par SHA-512.
- Le lanceur portable initialise Chromium avant Electron et le serveur répond à la vérification de disponibilité du bureau. Le `.deb` installe l’assistant du bac à sable Chromium avec propriétaire root et mode 4755. L’archive portable démarre sans le bac à sable Chromium lorsque cet assistant est indisponible ou sans ces permissions.

## Vérifications

- Version `1.0.16` compilée sur Ubuntu 24.04 x64 depuis `3865ba3`. Le paquet Debian et l’archive portable sont accompagnés de leurs sommes SHA-256. [Compilation GitHub Actions](https://github.com/zaalis/zaalis-labs-ide/actions/runs/44506642907)
- Le CLI embarqué, le serveur empaqueté, son terminal PTY et l’ouverture de la fenêtre Electron depuis l’archive sous X11 ont passé. La suite Linux compte 250 tests réussis, 6 ignorés et 0 échec.
- Les sessions Wayland strictes, le démarrage d’une VM avec KVM et les connexions aux comptes tiers restent à vérifier sur un poste Linux équipé.
