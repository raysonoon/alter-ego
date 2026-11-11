#include <Arduino.h>
#include <Adafruit_NeoPixel.h>

// Addressable RGB strip (WS2812B-style: VCC red, GND white, DATA green).
// The green DATA wire lands here.
#define LED_PIN 6
// Tune to your strip length.
#define NUM_LEDS 60

Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

// Per-state strip colours. APPROACH is a cool white whose brightness is supplied by the laptop
// on every frame, so it ramps up from faint to full as the player approaches.
const uint8_t IDLE_COLOR[3] = {255, 0, 0};          // red
const uint8_t APPROACH_COLOR[3] = {220, 235, 255};  // cool white
const uint8_t ENTRY_COLOR[3] = {0, 0, 255};         // blue
const uint8_t EXIT_COLOR[3] = {0, 255, 0};          // green

void setSolid(const uint8_t rgb[3]) {
  strip.fill(strip.Color(rgb[0], rgb[1], rgb[2]), 0, NUM_LEDS);
  strip.show();
}

// The laptop sends a two-byte frame: [command, brightness]. The bytes can land in separate
// loop() passes, so hold the command until its brightness byte arrives.
bool haveCommand = false;
uint8_t command = 0;

void setup() {
  strip.begin();
  strip.setBrightness(64);
  setSolid(IDLE_COLOR);  // IDLE = red at boot.
  // Native USB CDC ignores the baud rate, but it keeps Web Serial's open() call happy.
  Serial.begin(9600);
}

void loop() {
  while (Serial.available()) {
    const uint8_t b = Serial.read();
    if (!haveCommand) {
      command = b;
      haveCommand = true;
      continue;
    }
    haveCommand = false;

    const uint8_t* color = nullptr;
    switch (command) {
      case 'I': color = IDLE_COLOR; break;      // IDLE = red
      case 'A': color = APPROACH_COLOR; break;  // APPROACH = cool white (brightness ramps)
      case 'N': color = ENTRY_COLOR; break;     // ENTRY = blue
      case 'E': color = EXIT_COLOR; break;      // EXIT = green
      default: continue;
    }

    strip.setBrightness(b);
    setSolid(color);
  }
}
