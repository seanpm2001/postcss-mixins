var jsToCss = require('postcss-js/parser');
var postcss = require('postcss');
var globby  = require('globby');
var vars    = require('postcss-simple-vars');
var path    = require('path');
var fs      = require('fs');

function insideDefine(rule) {
    var parent = rule.parent;
    if ( !parent ) {
        return false;
    } else if ( parent.name === 'define-mixin' ) {
        return true;
    } else {
        return insideDefine(parent);
    }
}

function insertObject(rule, obj, processMixins) {
    var root = jsToCss(obj);
    root.each(function (node) {
        node.source = rule.source;
    });
    processMixins(root);
    rule.parent.insertBefore(rule, root);
}

function insertMixin(result, mixins, rule, processMixins, opts) {
    var name   = rule.params.split(/\s/, 1)[0];
    var params = rule.params.slice(name.length).trim();
    if ( params.indexOf(',') === -1 ) {
        params = postcss.list.space(params);
        if ( params.length > 1 ) {
            result.warn('Space argument separation is depreacted and ' +
                        'will be removed in next version. Use comma.',
                        { node: rule });
        }
    } else {
        params = postcss.list.comma(params);
    }

    var meta  = mixins[name];
    var mixin = meta && meta.mixin;

    if ( !meta ) {
        if ( !opts.silent ) {
            throw rule.error('Undefined mixin ' + name);
        }

    } else if ( mixin.name === 'define-mixin' ) {
        var i;
        var values = { };
        for ( i = 0; i < meta.args.length; i++ ) {
            values[meta.args[i][0]] = params[i] || meta.args[i][1];
        }

        var proxy = postcss.root();
        for ( i = 0; i < mixin.nodes.length; i++ ) {
            proxy.append( mixin.nodes[i].clone() );
        }

        if ( meta.args.length ) {
            vars({ only: values })(proxy);
        }
        if ( meta.content ) {
            proxy.walkAtRules('mixin-content', function (content) {
                if ( rule.nodes && rule.nodes.length > 0 ) {
                    content.replaceWith(rule.nodes);
                } else {
                    content.remove();
                }
            });
        }
        processMixins(proxy);

        rule.parent.insertBefore(rule, proxy);

    } else if ( typeof mixin === 'object' ) {
        insertObject(rule, mixin, processMixins);

    } else if ( typeof mixin === 'function' ) {
        var args  = [rule].concat(params);
        var nodes = mixin.apply(this, args);
        if ( typeof nodes === 'object' ) {
            insertObject(rule, nodes, processMixins);
        }
    }

    if ( rule.parent ) rule.remove();
}

function defineMixin(result, mixins, rule) {
    var name  = rule.params.split(/\s/, 1)[0];
    var other = rule.params.slice(name.length).trim();

    var args = [];
    if ( other.length ) {
        if ( other.indexOf(',') === -1 && other.indexOf(':') === -1 ) {
            args = other.split(/\s/).map(function (str) {
                return [str.slice(1), ''];
            });
            if ( args.length > 1 ) {
                result.warn('Space argument separation is depreacted and ' +
                            'will be removed in next version. Use comma.',
                            { node: rule });
            }

        } else {
            args = postcss.list.comma(other).map(function (str) {
                var arg      = str.split(':', 1)[0];
                var defaults = str.slice(arg.length + 1);
                return [arg.slice(1).trim(), defaults.trim()];
            });
        }
    }

    var content = false;
    rule.walkAtRules('mixin-content', function () {
        content = true;
        return false;
    });

    mixins[name] = { mixin: rule, args: args, content: content };
    rule.remove();
}

module.exports = postcss.plugin('postcss-mixins', function (opts) {
    if ( typeof opts === 'undefined' ) opts = { };

    var cwd    = process.cwd();
    var globs  = [];
    var mixins = { };

    if ( opts.mixinsDir ) {
        if ( !Array.isArray(opts.mixinsDir) ) {
            opts.mixinsDir = [opts.mixinsDir];
        }
        globs = opts.mixinsDir.map(function (dir) {
            return path.join(dir, '*.{js,json,css}');
        });
    }

    if ( opts.mixinsFiles ) globs = globs.concat(opts.mixinsFiles);

    return function (css, result) {
        var processMixins = function (root) {
            root.walkAtRules(function (i) {
                if ( i.name === 'mixin' ) {
                    if ( !insideDefine(i) ) {
                        insertMixin(result, mixins, i, processMixins, opts);
                    }
                } else if ( i.name === 'define-mixin' ) {
                    defineMixin(result, mixins, i);
                }
            });
        };

        return globby(globs, { nocase: true }).then(function (files) {
            return Promise.all(files.map(function (file) {
                var ext      = path.extname(file);
                var name     = path.basename(file, ext);
                var relative = path.join(cwd, path.relative(cwd, file));
                return new Promise(function (resolve, reject) {
                    if ( ext.toLowerCase() === '.css' ) {
                        fs.readFile(relative, function (err, contents) {
                            if ( err ) return reject(err);
                            postcss.parse(contents)
                                .walkAtRules('define-mixin', function (atrule) {
                                    defineMixin(result, mixins, atrule);
                                });
                            resolve();
                        });
                    } else {
                        mixins[name] = { mixin: require(relative) };
                        resolve();
                    }
                });
            }));
        }).then(function () {
            if ( typeof opts.mixins === 'object' ) {
                for ( var i in opts.mixins ) {
                    mixins[i] = { mixin: opts.mixins[i] };
                }
            }
            processMixins(css);
        });
    };
});
