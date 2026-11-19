# Achievement badge artwork

The ten badge images were generated with the built-in `image_gen` tool and copied into `interface/image/badges/`. Originals remain in the local generation directory. The product does not configure an external image-generation service.

Shared prompt, replacing the subject and identifier:

> Create one standalone small achievement badge icon for a desktop coding IDE: {subject}. Classic polished minimal illustration, clean front view, gold and cool slate blue palette, subtle highlights, crisp silhouette readable at 48 pixels, no text, no star shape, no surrounding badge or frame. Centered object occupying 75% of the square canvas. Transparent background. This is the {id} icon; return a saved PNG file usable in a project.

| Image | Prompt subject | Badge criterion |
| --- | --- | --- |
| spark.png | a single classic lightbulb | 10,000 tokens |
| worker.png | a single classic gold trophy | 3 active days |
| builder.png | a simple pair of stacked building blocks | 1 million tokens |
| terminal.png | a classic desktop terminal window with a simple command prompt chevron | 20 measured calls in 12 months |
| explorer.png | a single classic magnifying glass | 3 models used in 12 months |
| ideas.png | a classic fountain pen nib | 10 active days |
| architect.png | a classic drafting compass | 7 consecutive days |
| creator.png | a painter palette and brush | 100 million tokens |
| virtuoso.png | a simple laurel wreath with a central medallion | 30 consecutive days |
| legend.png | a classic gold crown | 1 billion tokens |

Active days, streaks, and tokens come from recorded measurements. Model and call badges use a 12-month window. Badges do not grant credits.
