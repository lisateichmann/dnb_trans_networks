const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv && argv.mode === 'production';

  return {
    mode: argv && argv.mode ? argv.mode : 'development',
    entry: './index.js',

    output: {
      filename: 'bundle.js',
      path: path.resolve(__dirname, 'dist'),
      // Use a relative publicPath for production so GitHub Pages serves assets correctly
      publicPath: isProd ? './' : '/',
      clean: true,
    },

    devServer: {
      // Serve both the built `dist` directory and the project root so `data/` and CSV
      // files are available during development without requiring a production build.
      static: [
        { directory: path.resolve(__dirname, 'dist') },
        { directory: path.resolve(__dirname) },
      ],
      open: true,
      port: 8080,
      compress: true,
      // Serve precompressed .gz for the large JSON during local dev when possible
      setupMiddlewares: (middlewares, devServer) => {
        if (!devServer) return middlewares;
        const fs = require('fs');
        const path = require('path');
        middlewares.unshift({
          name: 'serve-compressed-json',
          path: '/',
          middleware: (req, res, next) => {
            try {
              if (!req.url) return next();
              if (!req.url.endsWith('/author_author_graph.json')) return next();
              const gzPath = path.resolve(__dirname, 'dist', 'data', 'author_author_graph.json.gz');
              if (fs.existsSync(gzPath) && req.headers['accept-encoding'] && req.headers['accept-encoding'].includes('gzip')) {
                res.setHeader('Content-Encoding', 'gzip');
                res.setHeader('Content-Type', 'application/json');
                res.sendFile(gzPath);
                return;
              }
            } catch (err) {
              // ignore and fallback to normal static serving
            }
            return next();
          },
        });
        return middlewares;
      },
    },

    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: [], // No loader needed for plain JS
        },
        {
          test: /\.css$/i,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },

    plugins: [
      new HtmlWebpackPlugin({
        template: 'index.html',
        scriptLoading: 'defer',
        base: isProd ? './' : '/',
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'data', to: 'data' },
          { from: 'data.csv', to: 'data.csv' },
          { from: 'author_femaleonly.csv', to: 'author_femaleonly.csv' },
        ],
      }),
      new CompressionPlugin({
        filename: '[path][base].gz',
        algorithm: 'gzip',
        test: /\.(json|csv|js|css)$/,
        threshold: 10240,
        minRatio: 0.8,
        deleteOriginalAssets: false,
      }),
    ],

    resolve: {
      extensions: ['.js'],
    },
  };
};
