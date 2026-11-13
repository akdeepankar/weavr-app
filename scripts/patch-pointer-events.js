import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('node_modules/@pmndrs/pointer-events/dist/event.js');

if (fs.existsSync(filePath)) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Patch emitPointerEventRec
  if (content.includes('listeners[i](event);') && !content.includes('typeof listeners[i] === \'function\'')) {
    content = content.replace(
      'listeners[i](event);',
      'if (typeof listeners[i] === \'function\') { listeners[i](event); }',
    );
  }

  // Patch getObjectListeners
  if (content.includes('if (object._listeners != null && forEvent in object._listeners) {\n        return object._listeners[forEvent];\n    }')) {
    content = content.replace(
      'if (object._listeners != null && forEvent in object._listeners) {\n        return object._listeners[forEvent];\n    }',
      `if (object._listeners != null && forEvent in object._listeners) {
        const list = object._listeners[forEvent];
        if (Array.isArray(list)) {
            return list.filter((fn) => typeof fn === 'function');
        }
        return undefined;
    }`,
    );
  }

  if (content.includes('if (handler == null) {\n        return undefined;\n    }')) {
    content = content.replace(
      'if (handler == null) {\n        return undefined;\n    }',
      'if (typeof handler !== \'function\') {\n        return undefined;\n    }',
    );
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log('[WeaVR] Patched @pmndrs/pointer-events/dist/event.js successfully.');
}

