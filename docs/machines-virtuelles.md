# Machines virtuelles dans l’IDE Windows

Le panneau **Machines virtuelles**, dans la barre de droite, ouvre des sessions
distinctes. Linux utilise un vrai terminal SSH avec PTY et xterm. Windows Sandbox
utilise une console PowerShell persistante : navigation dans les dossiers et
commandes, mais pas d’éditeur plein écran, de saisie interactive dans les programmes
ou d’annulation d’une commande avec Ctrl+C. **Arrêter** interrompt toute la Sandbox.

Les agents disposent du même gestionnaire via l’outil natif `vm`, sans clics :
`list`, `create`, `status`, `import_project`, `exec`, `export_file`, `reset`, `stop`.
L’exécution de cet outil est autonome, même lorsque le PC hôte est en mode supervisé.
Le mode plan conserve son interdiction de mutation. Cette permission ne s’applique
ni aux commandes hôte ni à l’activation de composants Windows.

## Utilisation

1. Choisir Debian Linux ou Windows Sandbox et démarrer une VM.
2. Attendre **Prête**, puis utiliser le terminal ou demander à l’agent de travailler
   dans la VM. Jusqu’à trois Linux et une Windows Sandbox sont gérées simultanément.
3. **Copier le projet** importe une copie du projet actif. `.env`, clés usuelles,
   répertoires d’identifiants, `.git`, `node_modules`, `target` et liens symboliques
   sont exclus. Le transfert est limité à 256 Mo et 12 000 fichiers.
4. Les fichiers du projet sont dans `/home/zaalis/workspace` sous Linux et
   `C:\workspace` sous Windows. L’agent Linux utilise un shell indépendant pour
   chaque `exec` : commencer par `cd /home/zaalis/workspace && ...`.
5. **Récupérer un fichier** exporte un fichier invité de 32 Mo maximum avec un lien
   de téléchargement. Les résultats ne sont jamais appliqués au projet local.
6. **Repartir propre** arrête la session et démarre un nouvel environnement.
   Les anciens overlays restent dans les données locales ; pas de suppression
   automatique ni de récupération de snapshot dans cette première version.

Le réseau est désactivé par défaut. **Internet + réseau hôte** autorise aussi les
connexions vers le réseau local : ce réglage n’est pas un filtre « Internet seul ».
Il est nécessaire pour télécharger des dépendances. Une commande agent est limitée
à deux minutes, avec sorties bornées ; arrêter la VM interrompt les processus invités.

Windows Sandbox est lancé via `wsb`. Microsoft ne fournit pas de stdout/stderr
dans cette API : un script invité communique par un dossier dédié à la session.
Les commandes et la copie du projet passent par un dossier partagé en lecture seule.
Un second dossier dédié reçoit les résultats en écriture, jamais le dossier de
projet original. Un watchdog invité arrête la Sandbox si l’IDE ne renouvelle plus
son signal de présence pendant 30 secondes.
Une Sandbox ouverte en dehors de l’IDE n’est pas adoptée ou arrêtée.

## Préparation et distribution

Le pack Linux est intégré à l’installateur, en fichiers ordinaires à côté du
serveur : QEMU x86-64, ses bibliothèques et firmware, et une image officielle
Debian 12 genericcloud. Il n’est pas téléchargé lors de la première utilisation.
Les disques invités de 24 Go sont des overlays qcow2 : la base reste inchangée et
l’espace occupé dépend des écritures. Les clés SSH sont générées pour chaque VM,
les mots de passe SSH sont désactivés et le port SSH hôte écoute sur le loopback.

Sur une nouvelle machine Windows x64, l’accélération Windows Hypervisor Platform
et le client OpenSSH doivent être présents. La section de paramètres les détecte
et propose une activation par UAC. La virtualisation matérielle doit être activée
dans le firmware. Pour Sandbox, la compatibilité Pro/Enterprise/Education, l’état
du composant et la disponibilité de `wsb` sont vérifiés séparément. Un redémarrage
peut être nécessaire après activation ; aucun redémarrage n’est imposé par l’IDE.

```powershell
# Seulement sur la machine de compilation, pas chez l’utilisateur final.
powershell -File scripts/prepare-vm-assets.ps1 -Download
npm run build:server
npm run build:rust
cmd /c native\build_shell.bat
cmd /c native\build_installer.bat
```

QEMU est redistribué avec COPYING et COPYING.LIB ; Debian conserve ses licences
dans `/usr/share/doc`. La provenance et les SHA-512 sont dans `vm/provenance.json`.
Les fichiers binaires de préparation sont ignorés par Git.

## Validation reproductible

```powershell
npm test
cargo test --manifest-path rust/Cargo.toml -p zaalis-guard -p zaalis-extensions
node scripts/vm-smoke.js linux windows
node scripts/vm-mistral-smoke.js --fixture
node scripts/vm-mistral-smoke.js
```

Le scénario `--fixture` utilise le vrai moteur Rust et une vraie Windows Sandbox,
avec un fournisseur scripté : il prouve l’importation, la compilation C# et le
retour du test via `vm`, sans permission hôte. Il ne mesure pas la capacité d’un
modèle. Le dernier scénario utilise réellement Mistral Small avec une clé déjà
configurée. Une réponse 429 du fournisseur ne valide pas le comportement du modèle.
