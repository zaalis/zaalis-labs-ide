# Validation de l’intégration VM — 5 octobre 2026

## Livraison

- Panneau Machines virtuelles dans la barre droite, onglets de sessions,
  terminal xterm, choix Linux/Windows et réseau, démarrage, arrêt, environnement
  propre, copie de projet et récupération de fichiers.
- Paramètres Machines virtuelles : compatibilité/activation Windows Sandbox,
  disponibilité du CLI wsb, présence du pack Linux, WHPX et OpenSSH. Activation
  des composants par UAC, sans redémarrage automatique.
- Outil Rust `vm` avec accès autonome limité au gestionnaire de VM. Les
  commandes hôte en mode supervisé restent supervisées.
- Linux Debian 12, SSH interactif avec PTY, commandes d’agent par canal distinct,
  base qcow2 inchangée, overlays et clés SSH propres à chaque VM.
- Windows Sandbox : console PowerShell persistante, commandes directes sans
  clics, dossier d’entrée en lecture seule et dossier de sortie distinct.
  Le watchdog ferme la Sandbox après 30 secondes sans signal de l’IDE.

## Vérifications réussies

- Node : 74 tests, 73 réussis, 0 échec, 1 ignoré.
- Rust guard/extensions : 104 réussis, 0 échec, 7 tests réseau ignorés.
- Compilation du serveur Windows, du workspace Rust, de la coque native et
  de l’installateur Inno Setup.
- Vraie VM Linux : démarrage, uname Linux, code de sortie 7, terminal PTY,
  importation et exportation d’un fichier.
- Vraie Windows Sandbox : PowerShell, code de sortie 7, importation et
  exportation, refus d’une écriture dans le partage d’entrée, watchdog.
- Moteur Rust avec fournisseur scripté : importation par `vm`, compilation
  C# dans la Sandbox, récupération du marqueur et code de sortie 0, sans
  demande de permission hôte en mode supervisé. Ce test n’est pas un test
  de compétence d’un modèle.
- Nouvel exécutable serveur : deux Linux simultanés avec fichiers distincts,
  refus d’accès d’un autre utilisateur, réseau sortant bloqué en mode isolé,
  puis Windows Sandbox avec commande, importation et téléchargement HTTP.
- Interface vue dans le navigateur de test : terminal Linux avec sortie
  `UI_VM_TERMINAL_OK`, console Windows avec sortie `WINDOWS_UI_OK`, paramètres
  indiquant Sandbox prêt, pack Linux présent et accélération activée.
- `git diff --check` sans erreur après la construction. Toutes les VM de test
  sont arrêtées. Les modifications restent locales, sans commit ni publication.

## Résultats et limites

Mistral Small a été essayé avec une clé déjà configurée. Le fournisseur a
renvoyé 429 `rate_limited`, avant tout outil : son comportement n’est pas validé.
Les branches UAC n’ont pas été exécutées sur ce PC : Sandbox, WHPX et SSH étaient
déjà disponibles. Aucune fonction Windows n’a été désactivée pour simuler le test.

Le terminal Linux est un PTY. La console Windows n’est pas un PTY : pas de
programmes plein écran, de saisie native interactive ou de Ctrl+C interrompant
un processus déjà lancé. Le bouton Arrêter ferme toute la Sandbox. L’attente
d’une commande est bornée à deux minutes ; sur expiration Windows, la Sandbox
est arrêtée. Le réseau Internet permet également l’accès au réseau hôte.

La coque native est compilée ; la vérification visuelle a utilisé le navigateur
de test alimenté par le serveur compilé. L’installation et la désinstallation
sur la configuration existante n’ont pas été exécutées.

Le build conserve les avertissements pkg sur des fichiers Electron du navigateur
et les tests peuvent afficher `node-pty: AttachConsole failed` lors de la fermeture
d’un PTY. Les commandes, sorties, fermetures et tests concernés ont réussi malgré
ces messages. Aucun correctif général npm audit n’a été appliqué hors périmètre.

## Artefact

- Fichier : `native/installer/zaalis-setup.exe`
- Taille : **422 563 261 octets**, environ **403 Mio**.
- Pack Linux installé : environ **503 Mio**, dont l’image Debian de **333 Mio**.
- Signature : **NotSigned**.
- SHA-256 : `495FE0874FF3EE81F596F4C682BC7AB412239249C5BA114656E9C96843A9A20B`.
- Installateur antérieur conservé dans `.tmp/vm-backup/zaalis-setup-before-vm.exe`.

Le pack est livré avec l’installateur ; aucune ISO Linux ou installation QEMU
séparée n’est demandée à l’utilisateur. Les composants de virtualisation Windows
peuvent devoir être activés sur un autre PC, et certains outils de compilation
devront être installés dans les invités selon les projets.
