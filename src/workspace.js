'use strict';
(() => {
  const library = ['media', 'text', 'captions', 'filters', 'effects', 'stickers', 'icons', 'trans', 'layers', 'sounds'];
  const panels = [...library, 'player', 'insp', 'tl'];
  const group = (...tabs) => ({ tabs, active: tabs[0] });
  const fractions = sizes => {
    const total = sizes.reduce((sum, size) => sum + size, 0);
    return sizes.map(size => size / total);
  };
  function valid(tree) {
    const seen = new Set();
    function check(node) {
      if (!node) return false;
      if (!node.split) return Array.isArray(node.tabs) && node.tabs.includes(node.active) && node.tabs.every(tab => {
        if (!panels.includes(tab) || seen.has(tab)) return false;
        seen.add(tab);
        return true;
      });
      return ['row', 'col'].includes(node.split) && Array.isArray(node.children) && node.children.length > 1
        && Array.isArray(node.sizes) && node.sizes.length === node.children.length
        && node.sizes.every(n => Number.isFinite(n) && n > 0)
        && Math.abs(node.sizes.reduce((sum, n) => sum + n, 0) - 1) < 0.00001 && node.children.every(check);
    }
    return check(tree) && seen.size === panels.length;
  }
  function find(tree, tab) {
    return tree.split ? tree.children.map(node => find(node, tab)).find(Boolean) : tree.tabs.includes(tab) ? tree : null;
  }
  function move(tree, tab, targetTab, zone) {
    const source = find(tree, tab), target = find(tree, targetTab);
    if (!source || !target || source === target && (zone === 'center' || source.tabs.length === 1)) return tree;
    function visit(node) {
      if (node.split) {
        const children = [], sizes = [];
        node.children.forEach((child, i) => {
          const next = visit(child);
          if (next) { children.push(next); sizes.push(node.sizes[i]); }
        });
        if (children.length < 2) return children[0];
        return { split: node.split, sizes: fractions(sizes), children };
      }
      let leaf = node;
      if (node === source) {
        const tabs = leaf.tabs.filter(id => id !== tab);
        if (!tabs.length) return null;
        leaf = { tabs, active: leaf.active === tab ? tabs[0] : leaf.active };
      }
      if (node !== target) return leaf;
      if (zone === 'center') return { tabs: [...leaf.tabs, tab], active: tab };
      const beside = group(tab), before = zone === 'start' || zone === 'top';
      return { split: zone === 'start' || zone === 'end' ? 'row' : 'col', sizes: [0.5, 0.5], children: before ? [beside, leaf] : [leaf, beside] };
    }
    return visit(tree);
  }
  const api = { library, panels, group, fractions, valid, find, move };
  if (typeof module === 'object') module.exports = api;
  else window.MaqtoWorkspace = api;
})();
