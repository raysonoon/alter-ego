#include <Arduino.h>
#include <Adafruit_NeoPixel.h>

// Addressable RGB strip (WS2812B-style: VCC red, GND white, DATA green).
// The green DATA wire lands here.
#define LED_PIN 6
// Tune to your strip length.
#define NUM_LEDS 60

Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

void setSolid(uint8_t r, uint8_t g, uint8_t b) {
  strip.fill(strip.Color(r, g, b), 0, NUM_LEDS);
  strip.show();
}

void setup() {
  strip.begin();
  strip.setBrightness(64);
  setSolid(255, 0, 0);  // IDLE = red at boot.
  // Native USB CDC ignores the baud rate, but it keeps Web Serial's open() call happy.
  Serial.begin(9600);
}

void loop() {
  // Single-byte command from the laptop, sent only on state transitions.
  if (Serial.available()) {
    switch (Serial.read()) {
      case 'I': setSolid(255, 0, 0); break;  // IDLE = red
      case 'A': setSolid(0, 0, 255); break;  // APPROACH = blue
      case 'E': setSolid(0, 255, 0); break;  // EXIT = green
    }
  }
}
