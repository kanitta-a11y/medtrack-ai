app.post('/callback', (req, res) => {
    console.log('LINE webhook called');
    res.sendStatus(200);
});
