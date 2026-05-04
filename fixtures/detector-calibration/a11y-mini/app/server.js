#!/usr/bin/env node
// a11y-mini — minimal accessibility hygiene fixture.
// V56.3 batch grows this fixture as each a11y detector is wired.
//
// Routes for image_missing_alt:
//   /img-no-alt          — fires (positive: <img> with no alt attribute)
//   /img-with-alt        — silent (negative: <img alt="...">)
//   /img-empty-alt       — silent (edge: alt="" is decorative-image convention, intentional)
//   /img-aria-label      — silent (edge: aria-label provides accessible name)
//   /multi-img-mixed     — fires (one of two imgs is missing alt)
//   /malformed-no-alt    — fires (input degradation: malformed HTML, img missing alt)

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9953;

function html(status, body) {
  return { status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body };
}

const ROUTES = {
  '/img-no-alt': html(
    200,
    '<!doctype html><html><head><title>No Alt</title></head><body><img src="/cat.png"><p>No alt</p></body></html>',
  ),
  '/img-with-alt': html(
    200,
    '<!doctype html><html><head><title>Has Alt</title></head><body><img src="/cat.png" alt="A friendly cat"><p>Has alt</p></body></html>',
  ),
  '/img-empty-alt': html(
    200,
    // Edge: alt="" is the explicit decorative-image convention. Should be silent.
    '<!doctype html><html><head><title>Empty Alt</title></head><body><img src="/decoration.png" alt=""><p>Decorative</p></body></html>',
  ),
  '/img-aria-label': html(
    200,
    // Edge: aria-label provides accessible name in absence of alt
    '<!doctype html><html><head><title>Aria Label</title></head><body><img src="/logo.png" aria-label="Company logo"><p>Logo</p></body></html>',
  ),
  '/multi-img-mixed': html(
    200,
    // Two images: first has alt, second does not. Detector should fire on second only.
    '<!doctype html><html><head><title>Mixed</title></head><body><img src="/a.png" alt="First"><img src="/b.png"><p>Mixed</p></body></html>',
  ),
  '/malformed-no-alt': html(
    200,
    // Input degradation: malformed HTML, img without alt
    '<!doctype html><html<><head><title>Malformed</title></head<><body<><img src="/x.png"<><p>Mal</p></body></html>',
  ),

  // form_input_unlabeled routes
  '/input-no-label': html(
    200,
    // Positive: input has neither for-linked label, nor wrapped label, nor aria-label
    '<!doctype html><html><head><title>No Label</title></head><body><form><input type="text" name="email"></form></body></html>',
  ),
  '/input-label-for': html(
    200,
    // Negative: <label for="x"><input id="x">
    '<!doctype html><html><head><title>For Label</title></head><body><form><label for="email">Email</label><input id="email" type="email"></form></body></html>',
  ),
  '/input-wrapped-label': html(
    200,
    // Edge: <label>Text <input></label>
    '<!doctype html><html><head><title>Wrapped Label</title></head><body><form><label>Name <input type="text" name="name"></label></form></body></html>',
  ),
  '/input-aria-label': html(
    200,
    // Edge: aria-label provides accessible name
    '<!doctype html><html><head><title>Aria Label</title></head><body><form><input type="text" name="search" aria-label="Search query"></form></body></html>',
  ),
  '/input-hidden': html(
    200,
    // Edge: hidden inputs are not user-facing — silent
    '<!doctype html><html><head><title>Hidden</title></head><body><form><input type="hidden" name="csrf" value="abc123"></form></body></html>',
  ),
  '/input-submit-with-value': html(
    200,
    // Edge: submit with value — the button value IS the accessible name
    '<!doctype html><html><head><title>Submit</title></head><body><form><input type="submit" value="Save changes"></form></body></html>',
  ),
  '/multi-input-mixed': html(
    200,
    // 2 inputs: one for-linked label, one bare → fire on the bare one
    '<!doctype html><html><head><title>Mixed</title></head><body><form><label for="a">A</label><input id="a" type="text"><input type="text" name="b"></form></body></html>',
  ),
  '/malformed-no-label': html(
    200,
    // Input degradation: malformed HTML, input without any label mechanism
    '<!doctype html><html<><head><title>Malformed</title></head<><body<><form<><input type="text" name="x"<></form></body></html>',
  ),

  // interactive_element_missing_accessible_name routes
  '/button-no-name': html(
    200,
    // Positive: <button> with empty content and no aria-label
    '<!doctype html><html><head><title>No Name</title></head><body><button></button></body></html>',
  ),
  '/button-with-text': html(
    200,
    // Negative: visible text content
    '<!doctype html><html><head><title>With Text</title></head><body><button>Click me</button></body></html>',
  ),
  '/button-aria-label': html(
    200,
    // Edge: aria-label provides accessible name without visible text
    '<!doctype html><html><head><title>Aria</title></head><body><button aria-label="Close dialog"></button></body></html>',
  ),
  '/button-icon-with-img-alt': html(
    200,
    // Edge: button content is an <img> with non-empty alt — alt becomes the accessible name
    '<!doctype html><html><head><title>Icon</title></head><body><button><img src="/save.png" alt="Save"></button></body></html>',
  ),
  '/link-no-name': html(
    200,
    // Positive: anchor with href but no text and no aria-label
    '<!doctype html><html><head><title>No Link Name</title></head><body><a href="/x"></a></body></html>',
  ),
  '/link-with-text': html(
    200,
    // Negative: visible text
    '<!doctype html><html><head><title>Link Text</title></head><body><a href="/x">Home</a></body></html>',
  ),
  '/multi-mixed-interactive': html(
    200,
    // 2 buttons: one labeled, one bare — should fire on the bare one
    '<!doctype html><html><head><title>Mixed</title></head><body><button>OK</button><button></button></body></html>',
  ),
  '/malformed-no-name': html(
    200,
    // Input degradation: malformed HTML, button has no name
    '<!doctype html><html<><head><title>Mal</title></head<><body<><button<></button></body></html>',
  ),
};

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/__bughunter_reset') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const route = ROUTES[pathname];
  if (route !== undefined) {
    res.writeHead(route.status, route.headers);
    res.end(route.body);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`a11y-mini ready on port ${PORT}\n`);
});
