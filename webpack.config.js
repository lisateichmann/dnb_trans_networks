const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const CompressionPlugin = require('compression-webpack-plugin');

module.exports = {
  mode: 'development',
  entry: './index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    publicPath: '/dnb_trans_networks/', // Set for GitHub Pages deployment
    clean: true,
  },
  devServer: {
    static: './dist',
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
        }
      });
      return middlewares;
    }
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: [], // No loader needed for plain JS, but this ensures parsing
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
      base: '/dnb_trans_networks/',
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'data', to: 'data' },
        { from: 'data.csv', to: 'data.csv' }
      ],
    }),
    new CompressionPlugin({
      filename: '[path][base].gz',
      algorithm: 'gzip',
      test: /\.(json|csv|js|css)$/,
      threshold: 10240, // only compress files larger than 10 KB
      minRatio: 0.8,
      deleteOriginalAssets: false
    }),
  ],
  resolve: {
    extensions: ['.js'],
  },
};
