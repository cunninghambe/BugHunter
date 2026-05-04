#!/usr/bin/env node
// seo-mini — minimal SEO hygiene fixture.
// V56.3 batch grows this fixture as each SEO detector is wired.
//
// Routes for seo_title_missing:
//   /no-title           — fires (no <title> in document)
//   /empty-title        — fires (edge: <title></title> present but empty)
//   /whitespace-title   — fires (edge: <title>   </title> whitespace-only)
//   /good-title         — silent (negative: well-formed unique title)
//   /malformed          — fires (input degradation: HTML is malformed but a title is missing)

'use strict';

const http = require('node:http');
const url = require('node:url');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9963;

function html(status, body) {
  return { status, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body };
}

const ROUTES = {
  '/no-title': html(
    200,
    '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Hello</h1><p>This page has no title element.</p></body></html>',
  ),
  '/empty-title': html(
    200,
    '<!doctype html><html><head><title></title><meta charset="utf-8"></head><body><h1>Empty Title</h1></body></html>',
  ),
  '/whitespace-title': html(
    200,
    '<!doctype html><html><head><title>   \t\n   </title></head><body><h1>Whitespace Title</h1></body></html>',
  ),
  '/good-title': html(
    200,
    '<!doctype html><html><head><title>Properly Titled Page</title></head><body><h1>Good</h1></body></html>',
  ),
  '/malformed': html(
    200,
    '<!doctype html><html><head><meta charset="utf-8"<><body><h1>Malformed</h1></body></html>',
  ),

  // seo_meta_description_missing routes
  '/no-meta-desc': html(
    200,
    '<!doctype html><html><head><title>No Meta Desc</title></head><body><h1>Hi</h1></body></html>',
  ),
  '/empty-meta-desc': html(
    200,
    '<!doctype html><html><head><title>Empty Desc</title><meta name="description" content=""></head><body><h1>Hi</h1></body></html>',
  ),
  '/whitespace-meta-desc': html(
    200,
    '<!doctype html><html><head><title>WS Desc</title><meta name="description" content="   "></head><body><h1>Hi</h1></body></html>',
  ),
  '/good-meta-desc': html(
    200,
    '<!doctype html><html><head><title>Good Desc</title><meta name="description" content="A real meaningful description of this page."></head><body><h1>Hi</h1></body></html>',
  ),
  '/meta-desc-attrs-reversed': html(
    200,
    // Tests that attribute order does not matter (content="..." before name="description")
    '<!doctype html><html><head><title>Reversed Attrs</title><meta content="Reversed attribute order works" name="description"></head><body><h1>Hi</h1></body></html>',
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
  process.stdout.write(`seo-mini ready on port ${PORT}\n`);
});
