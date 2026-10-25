# Car models

Every car the traffic drives (and the player can steal) is a plain data entry here, one file per make. Each one is
drawn with one of the shared body shapes (sedan, taxi, suv, pickup, van & hatch in `js/actors/actor-models.js`; coupe,
fastback & wedge in `../bodies.js`), stretched to the car's real length, width and height, and driven by a drivetrain built from its real numbers
(`js/player/drivetrain.js` `buildSpec`).

To add a car: add an entry to its make's file (or a new `<make>.js` listed in `index.js`). Fields:

| Field | Meaning |
|---|---|
| `id` | unique, `make-model` |
| `name` | what the HUD shows |
| `body` | one of the body shapes |
| `size` | `[length, width, height]` in metres |
| `mass` | kg with a driver |
| `drive` | `'fwd'`, `'rwd'` or `'awd'` |
| `power` | `[kW, rpm]` peak power |
| `torque` | `[N·m, rpm]` peak torque |
| `redline` | rpm (an EV: its motor's top rpm) |
| `gears` | forward gears (an EV: 1) |
| `top` | top speed, km/h; `limited: true` when an electronic limiter sets it |
| `electric` | battery-electric: one gear, full torque from 0 rpm, regenerative braking |
| `rarity` | how often it turns up in traffic (weights: ~20 for the best sellers, 0.05 for a Ferrari) |
| `paints` | optional body colours (hex); a sensible palette otherwise |
| `class` | `economy`, `family`, `truck`, `premium`, `sport` or `super`: tyres & brakes |
| `traffic` | `false` keeps it out of the random traffic (the taxi and the police car have their own slots) |

Figures are the Mexican-market versions where there is one (manufacturer data sheets); top speeds are the makers'.
