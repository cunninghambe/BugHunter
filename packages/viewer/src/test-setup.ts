import '@testing-library/jest-dom';

// jsdom's File/Blob don't implement text(), arrayBuffer(), or stream().
// Polyfill them so directory-loader tests work without a real browser.
if (typeof File !== 'undefined' && typeof File.prototype.text === 'undefined') {
  File.prototype.text = function (): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text === 'undefined') {
  Blob.prototype.text = function (): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

// jsdom doesn't implement scrollIntoView.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => { /* no-op in jsdom */ };
}
